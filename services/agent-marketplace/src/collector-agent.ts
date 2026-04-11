import { Redis } from "ioredis";
import type { Knex } from "knex";
import type { TelemetryRecord } from "@airchive/types";
import { createLogger } from "@airchive/logger";
import { PRODUCTS, getPrice } from "./data-products.js";
import { agentPaymentsTotal, agentMessagesTotal, dataRequestLatency } from "./metrics.js";
import type { AgentActivityPublisher } from "./activity-publisher.js";

const log = createLogger({ service: "collector-agent" });

export interface CollectorWallet {
  getIdentityKey(): string;
  getAddress(): string;
  registerIdentityTag(tag: string): Promise<{ tag: string }>;
  certifyForMessageBox(handle: string): Promise<{ txid: string; handle: string }>;
  listIncomingPayments(): Promise<any[]>;
  acceptIncomingPayment(payment: any): Promise<any>;
  inscribeText(text: string): Promise<{ txid: string }>;
}

export interface DataRequest {
  requestId: string;
  product: string;
  params?: Record<string, string>;
  requesterKey: string;
  paymentTxid?: string;
}

export interface DataResponse {
  requestId: string;
  product: string;
  data: unknown;
  timestamp: number;
  collectorKey: string;
}

export class CollectorAgent {
  private readonly redis: Redis;
  private readonly db: Knex;
  private readonly trackedAircraft: string[];
  private readonly activityPub: AgentActivityPublisher;
  private wallet: CollectorWallet | null = null;
  private identityKey = "";
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private latestTelemetry = new Map<string, TelemetryRecord>();
  private subscriber: Redis | null = null;

  constructor(
    redis: Redis,
    db: Knex,
    trackedAircraft: string[],
    activityPub: AgentActivityPublisher,
  ) {
    this.redis = redis;
    this.db = db;
    this.trackedAircraft = trackedAircraft;
    this.activityPub = activityPub;
  }

  async start(wallet: CollectorWallet): Promise<void> {
    this.wallet = wallet;
    this.identityKey = wallet.getIdentityKey();
    this.running = true;

    log.info({ identityKey: this.identityKey }, "Collector agent starting");

    try {
      const result = await wallet.registerIdentityTag("airchive-collector");
      log.info({ tag: result.tag }, "Registered identity tag");
      await this.activityPub.publishDiscovery(
        "collector",
        this.identityKey,
        "Registered identity tag: airchive-collector",
      );
    } catch (err) {
      log.warn({ err }, "Identity tag registration failed (may already exist)");
    }

    try {
      const cert = await wallet.certifyForMessageBox("airchive-collector");
      log.info({ txid: cert.txid }, "Certified for MessageBox");
    } catch (err) {
      log.warn({ err }, "MessageBox certification failed (may already exist)");
    }

    this.subscriber = this.redis.duplicate();
    await this.subscriber.connect();

    const channels = this.trackedAircraft.map((icao) => `telemetry:${icao}`);
    if (channels.length > 0) {
      await this.subscriber.subscribe(...channels);
    }

    this.subscriber.on("message", (_channel: string, message: string) => {
      try {
        const record = JSON.parse(message) as TelemetryRecord;
        if (record.icao) {
          this.latestTelemetry.set(record.icao.toUpperCase(), record);
        }
      } catch { /* ignore */ }
    });

    this.pollTimer = setInterval(() => {
      void this.processIncomingPayments();
    }, 5_000);

    log.info(
      { aircraft: this.trackedAircraft.length },
      "Collector agent started — listening for data requests",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    log.info("Collector agent stopped");
  }

  getIdentityKey(): string {
    return this.identityKey;
  }

  getProductCatalogue(): typeof PRODUCTS {
    return PRODUCTS;
  }

  async fulfilRequest(request: DataRequest): Promise<DataResponse> {
    const start = Date.now();
    const product = request.product;
    let data: unknown;

    switch (product) {
      case "live_telemetry": {
        const icao = request.params?.icao?.toUpperCase();
        if (icao) {
          data = this.latestTelemetry.get(icao) ?? null;
        } else {
          data = null;
        }
        break;
      }
      case "fleet_snapshot": {
        data = Object.fromEntries(this.latestTelemetry);
        break;
      }
      case "flight_history": {
        const flightId = request.params?.flight_id;
        if (flightId) {
          const rows = await this.db("tx_results")
            .where({ flight_id: flightId, record_type: 0x01 })
            .orderBy("timestamp", "asc")
            .limit(100);
          data = rows;
        } else {
          data = [];
        }
        break;
      }
      case "phase_events": {
        const fid = request.params?.flight_id;
        if (fid) {
          const rows = await this.db("tx_results")
            .where({ flight_id: fid, record_type: 0x02 })
            .orderBy("timestamp", "asc");
          data = rows;
        } else {
          data = [];
        }
        break;
      }
      default:
        data = null;
    }

    const latency = (Date.now() - start) / 1000;
    dataRequestLatency.observe({ product }, latency);
    agentMessagesTotal.inc({ agent: "collector", direction: "outbound" });

    const response: DataResponse = {
      requestId: request.requestId,
      product,
      data,
      timestamp: Date.now(),
      collectorKey: this.identityKey,
    };

    await this.activityPub.publishTransaction(
      "collector",
      "data_sale",
      getPrice(product),
      product,
      request.requesterKey,
    );

    return response;
  }

  private async processIncomingPayments(): Promise<void> {
    if (!this.wallet || !this.running) return;

    try {
      const payments = await this.wallet.listIncomingPayments();
      for (const payment of payments) {
        try {
          await this.wallet.acceptIncomingPayment(payment);
          agentPaymentsTotal.inc({
            from_agent: "external",
            to_agent: "collector",
            product: "payment",
          });
          log.debug({ sender: payment.sender }, "Accepted incoming payment");
        } catch (err) {
          log.warn({ err }, "Failed to accept payment");
        }
      }
    } catch (err) {
      log.debug({ err }, "No incoming payments or check failed");
    }
  }

  getFleetSnapshot(): Map<string, TelemetryRecord> {
    return this.latestTelemetry;
  }
}
