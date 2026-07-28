import type { Knex } from "knex";
import { RecordType } from "@airchive/types";
import { createLogger } from "@airchive/logger";
import { inscribeAgentRecord, type InscriptionSink } from "./agent-inscriptions.js";
import { getPrice } from "./data-products.js";
import {
  agentPaymentsTotal,
  agentMessagesTotal,
} from "./metrics.js";
import type { CollectorAgent } from "./collector-agent.js";
import type { AgentActivityPublisher } from "./activity-publisher.js";
import { identityRegistryUnavailable } from "./identity-utils.js";

const log = createLogger({ service: "monitor-agent" });

/** Two missed inscriptions in a row means the agent is not actually working. */
const UNHEALTHY_FAILURE_STREAK = 2;

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
  private lastSweepMark = 0;
  private sweepStartedAt = Date.now();
  private readonly sweepCovered = new Set<string>();
  private lastCycleAt = 0;
  private lastInscriptionAt = 0;
  private consecutiveInscriptionFailures = 0;

  constructor(
    collector: CollectorAgent,
    activityPub: AgentActivityPublisher,
    trackedAircraft: string[],
    intervalMs: number,
    private readonly db: Knex,
    private readonly sink: InscriptionSink | null,
  ) {
    this.collector = collector;
    this.activityPub = activityPub;
    this.trackedAircraft = trackedAircraft;
    this.intervalMs = intervalMs;
  }

  getHealth(): { status: "running" | "degraded" | "stopped"; detail: string } {
    if (!this.running) return { status: "stopped", detail: "Agent is not running" };

    const cycleGap = Date.now() - this.lastCycleAt;
    if (this.lastCycleAt > 0 && cycleGap > this.intervalMs * 5) {
      return {
        status: "degraded",
        detail: `No completed cycle for ${Math.round(cycleGap / 1000)}s`,
      };
    }
    if (this.consecutiveInscriptionFailures >= UNHEALTHY_FAILURE_STREAK) {
      return {
        status: "degraded",
        detail: `${this.consecutiveInscriptionFailures} consecutive inscription failures`,
      };
    }
    return {
      status: "running",
      detail: this.lastInscriptionAt > 0
        ? `Last sweep inscription ${Math.round((Date.now() - this.lastInscriptionAt) / 1000)}s ago`
        : "Awaiting first fleet sweep",
    };
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
      if (identityRegistryUnavailable(err)) {
        log.info("Identity registry unavailable — skipping monitor tag registration");
      } else {
        log.warn({ err }, "Identity tag registration failed (may already exist)");
      }
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
      if (identityRegistryUnavailable(err)) {
        log.info("Identity registry unavailable — using direct collector reference");
      } else {
        log.warn({ err }, "Identity lookup failed — using direct collector reference");
      }
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
        this.sweepCovered.add(icao);
        await this.activityPub.publishTransaction(
          "monitor",
          "telemetry_query",
          price,
          `live_telemetry:${icao}`,
          this.collectorKey,
        );
      }

      // Inscribe once the sweep has covered the fleet, so the cadence follows
      // coverage rather than an arbitrary cycle count that meant ~8 minutes for
      // a small fleet and hours for a large one.
      if (this.aircraftIndex - this.lastSweepMark >= this.trackedAircraft.length) {
        this.lastSweepMark = this.aircraftIndex;
        const sweepEndedAt = Date.now();
        const sweepStartedAt = this.sweepStartedAt;
        const snapshot = this.collector.getFleetSnapshot();
        const records = Array.from(snapshot.values());
        const airborneCount = records.filter((r) => !r.on_ground).length;

        const inscription = await inscribeAgentRecord({
          db: this.db,
          sink: this.sink,
          agentLabel: "monitor",
          recordType: RecordType.AGENT_MONITOR,
          record: {
            v: 1,
            // A sweep describes an interval, not an instant, and transactions
            // are batched and mined out of order — so the window is stated
            // explicitly rather than inferred from when the record landed.
            ts: sweepEndedAt,
            windowStart: sweepStartedAt,
            windowEnd: sweepEndedAt,
            cycle: this.cycleCount,
            sweepSize: this.trackedAircraft.length,
            covered: this.sweepCovered.size,
            observed: records.length,
            airborne: airborneCount,
            grounded: records.length - airborneCount,
            unseen: this.trackedAircraft.filter((tracked) => !this.sweepCovered.has(tracked)),
            totalSpentSats: this.totalSpentSats,
          },
        });

        if (inscription) {
          this.lastInscriptionAt = Date.now();
          this.consecutiveInscriptionFailures = 0;
        } else {
          this.consecutiveInscriptionFailures++;
        }
        this.sweepCovered.clear();
        this.sweepStartedAt = sweepEndedAt;
      }

      this.lastCycleAt = Date.now();
    } catch (err) {
      log.error({ err, cycle: this.cycleCount }, "Monitor cycle failed");
    }

    this.scheduleNextCycle();
  }
}
