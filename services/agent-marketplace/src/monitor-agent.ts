import { createLogger } from "@airchive/logger";
import { getPrice } from "./data-products.js";
import {
  agentPaymentsTotal,
  agentMessagesTotal,
} from "./metrics.js";
import type { CollectorAgent } from "./collector-agent.js";
import type { AgentActivityPublisher } from "./activity-publisher.js";

const log = createLogger({ service: "monitor-agent" });

export interface MonitorWallet {
  getIdentityKey(): string;
  getAddress(): string;
  registerIdentityTag(tag: string): Promise<{ tag: string }>;
  lookupIdentityByTag(query: string): Promise<Array<{ tag: string; identityKey: string }>>;
  inscribeText(text: string): Promise<{ txid: string }>;
  sendMessageBoxPayment(to: string, satoshis: number): Promise<any>;
}

export class MonitorAgent {
  private readonly collector: CollectorAgent;
  private readonly activityPub: AgentActivityPublisher;
  private readonly trackedAircraft: string[];
  private readonly intervalMs: number;
  private wallet: MonitorWallet | null = null;
  private identityKey = "";
  private collectorKey = "";
  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleCount = 0;
  private totalSpentSats = 0;
  private aircraftIndex = 0;

  constructor(
    collector: CollectorAgent,
    activityPub: AgentActivityPublisher,
    trackedAircraft: string[],
    intervalMs: number,
  ) {
    this.collector = collector;
    this.activityPub = activityPub;
    this.trackedAircraft = trackedAircraft;
    this.intervalMs = intervalMs;
  }

  async start(wallet: MonitorWallet): Promise<void> {
    this.wallet = wallet;
    this.identityKey = wallet.getIdentityKey();
    this.running = true;

    log.info({ identityKey: this.identityKey }, "Monitor agent starting");

    try {
      const result = await wallet.registerIdentityTag("airchive-monitor");
      log.info({ tag: result.tag }, "Registered identity tag");
      await this.activityPub.publishDiscovery(
        "monitor",
        this.identityKey,
        "Registered identity tag: airchive-monitor",
      );
    } catch (err) {
      log.warn({ err }, "Identity tag registration failed (may already exist)");
    }

    await this.discoverCollector();

    this.scheduleNextCycle();
    log.info(
      { intervalMs: this.intervalMs, aircraft: this.trackedAircraft.length },
      "Monitor agent started — per-aircraft query loop running",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    log.info(
      { cycles: this.cycleCount, totalSpent: this.totalSpentSats },
      "Monitor agent stopped",
    );
  }

  getIdentityKey(): string {
    return this.identityKey;
  }

  getStats(): { cycles: number; totalSpentSats: number } {
    return { cycles: this.cycleCount, totalSpentSats: this.totalSpentSats };
  }

  private async discoverCollector(): Promise<void> {
    if (!this.wallet) return;

    try {
      const results = await this.wallet.lookupIdentityByTag("airchive-collector");
      if (results.length > 0) {
        this.collectorKey = results[0]!.identityKey;
        log.info(
          { collectorKey: this.collectorKey },
          "Discovered Collector agent via BRC-100 identity registry",
        );
        await this.activityPub.publishDiscovery(
          "monitor",
          this.identityKey,
          `Discovered collector: ${this.collectorKey.slice(0, 16)}...`,
        );
      } else {
        this.collectorKey = this.collector.getIdentityKey();
        log.info("No registry result — using direct collector reference");
      }
    } catch (err) {
      this.collectorKey = this.collector.getIdentityKey();
      log.warn({ err }, "Identity lookup failed — using direct collector reference");
    }
  }

  private scheduleNextCycle(): void {
    if (!this.running) return;
    this.loopTimer = setTimeout(() => void this.runCycle(), this.intervalMs);
  }

  private async runCycle(): Promise<void> {
    if (!this.running || !this.wallet) return;

    try {
      this.cycleCount++;

      const icao = this.trackedAircraft[this.aircraftIndex % this.trackedAircraft.length]!;
      this.aircraftIndex++;

      const requestId = `mon_${Date.now()}_${icao}`;

      agentMessagesTotal.inc({ agent: "monitor", direction: "outbound" });

      const response = await this.collector.fulfilRequest({
        requestId,
        product: "live_telemetry",
        params: { icao },
        requesterKey: this.identityKey,
      });

      agentMessagesTotal.inc({ agent: "monitor", direction: "inbound" });

      const price = getPrice("live_telemetry");
      if (this.collectorKey && price > 0) {
        try {
          await this.wallet.sendMessageBoxPayment(this.collectorKey, price);
          this.totalSpentSats += price;
          agentPaymentsTotal.inc({
            from_agent: "monitor",
            to_agent: "collector",
            product: "live_telemetry",
          });
        } catch (err) {
          log.debug({ err }, "MessageBox payment failed (non-fatal)");
        }
      }

      if (response.data) {
        await this.activityPub.publishTransaction(
          "monitor",
          "telemetry_query",
          price,
          `live_telemetry:${icao}`,
          this.collectorKey,
        );
      }

      if (this.cycleCount % 100 === 0) {
        try {
          const snapshot = this.collector.getFleetSnapshot();
          const airborneCount = Array.from(snapshot.values()).filter(
            (r) => !r.on_ground,
          ).length;

          await this.wallet.inscribeText(
            JSON.stringify({
              type: "AIRCHIVE_MONITOR",
              version: 1,
              ts: Date.now(),
              cycle: this.cycleCount,
              queriedIcao: icao,
              airborneCount,
              totalSpentSats: this.totalSpentSats,
            }),
          );
        } catch (err) {
          log.debug({ err }, "Monitor inscription failed (non-fatal)");
        }
      }
    } catch (err) {
      log.error({ err, cycle: this.cycleCount }, "Monitor cycle failed");
    }

    this.scheduleNextCycle();
  }
}
