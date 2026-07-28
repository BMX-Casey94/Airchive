import type { Knex } from "knex";
import type { TelemetryRecord } from "@airchive/types";
import { RecordType } from "@airchive/types";
import { createLogger } from "@airchive/logger";
import {
  analyseFleet,
  summariseAnalysis,
  type Anomaly,
  type FleetAnalysis,
} from "./analysis-engine.js";
import { inscribeAgentRecord, type InscriptionSink } from "./agent-inscriptions.js";
import { getPrice } from "./data-products.js";
import {
  agentPaymentsTotal,
  agentMessagesTotal,
  analysisPublishedTotal,
} from "./metrics.js";
import type { CollectorAgent } from "./collector-agent.js";
import type { AgentActivityPublisher } from "./activity-publisher.js";
import { identityRegistryUnavailable } from "./identity-utils.js";

const log = createLogger({ service: "analyst-agent" });

/**
 * Anomalies are inscribed in full rather than as a count, but the payload still
 * has to fit an OP_RETURN comfortably. Highest severity first, so a truncated
 * list never drops a critical event in favour of an informational one.
 */
const MAX_INSCRIBED_ANOMALIES = 25;
const MAX_INSCRIBED_STALE = 50;
/** Two missed inscriptions in a row means the agent is not actually working. */
const UNHEALTHY_FAILURE_STREAK = 2;

const SEVERITY_RANK: Record<Anomaly["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function buildAnalysisRecord(
  analysis: FleetAnalysis,
  summary: string,
): Record<string, unknown> {
  const ranked = [...analysis.anomalies].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  return {
    v: 1,
    ts: analysis.timestamp,
    summary,
    totalAircraft: analysis.totalAircraft,
    airborne: analysis.airborne,
    grounded: analysis.grounded,
    avgAltFt: analysis.avgAltitudeFt,
    avgGsKts: analysis.avgGroundSpeedKts,
    maxAltFt: analysis.maxAltitudeFt,
    maxSpeedKts: analysis.maxSpeedKts,
    phases: analysis.phaseDistribution,
    anomalyCount: analysis.anomalies.length,
    anomalies: ranked.slice(0, MAX_INSCRIBED_ANOMALIES).map((anomaly) => ({
      icao: anomaly.icao,
      type: anomaly.type,
      severity: anomaly.severity,
      value: anomaly.value,
      threshold: anomaly.threshold,
    })),
    staleCount: analysis.staleAircraft.length,
    stale: analysis.staleAircraft.slice(0, MAX_INSCRIBED_STALE),
  };
}

export interface AnalystWallet {
  getIdentityKey(): string;
  getAddress(): string;
  registerIdentityTag(tag: string): Promise<{ tag: string }>;
  lookupIdentityByTag(query: string): Promise<Array<{ tag: string; identityKey: string }>>;
  inscribeText(text: string): Promise<{ txid: string }>;
  sendMessageBoxPayment(to: string, satoshis: number): Promise<any>;
}

export class AnalystAgent {
  private readonly collector: CollectorAgent;
  private readonly activityPub: AgentActivityPublisher;
  private readonly intervalMs: number;
  private wallet: AnalystWallet | null = null;
  private identityKey = "";
  private collectorKey = "";
  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleCount = 0;
  private totalSpentSats = 0;
  private lastAnalysis: FleetAnalysis | null = null;
  private lastCycleAt = 0;
  private lastInscriptionAt = 0;
  private consecutiveInscriptionFailures = 0;

  constructor(
    collector: CollectorAgent,
    activityPub: AgentActivityPublisher,
    intervalMs: number,
    private readonly db: Knex,
    private readonly sink: InscriptionSink | null,
  ) {
    this.collector = collector;
    this.activityPub = activityPub;
    this.intervalMs = intervalMs;
  }

  /**
   * Real health, not a timer. An agent that cannot land records on-chain is
   * degraded no matter how reliably its loop ticks.
   */
  getHealth(): { status: "running" | "degraded" | "stopped"; detail: string } {
    if (!this.running) return { status: "stopped", detail: "Agent is not running" };

    const cycleGap = Date.now() - this.lastCycleAt;
    if (this.lastCycleAt > 0 && cycleGap > this.intervalMs * 3) {
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
        ? `Last inscription ${Math.round((Date.now() - this.lastInscriptionAt) / 1000)}s ago`
        : "Awaiting first inscription",
    };
  }

  async start(wallet: AnalystWallet): Promise<void> {
    this.wallet = wallet;
    this.identityKey = wallet.getIdentityKey();
    this.running = true;

    log.info({ identityKey: this.identityKey }, "Analyst agent starting");

    try {
      const result = await wallet.registerIdentityTag("airchive-analyst");
      log.info({ tag: result.tag }, "Registered identity tag");
      await this.activityPub.publishDiscovery(
        "analyst",
        this.identityKey,
        "Registered identity tag: airchive-analyst",
      );
    } catch (err) {
      if (identityRegistryUnavailable(err)) {
        log.info("Identity registry unavailable — skipping analyst tag registration");
      } else {
        log.warn({ err }, "Identity tag registration failed (may already exist)");
      }
    }

    await this.discoverCollector();

    this.scheduleNextCycle();
    log.info({ intervalMs: this.intervalMs }, "Analyst agent started — analysis loop running");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    log.info(
      { cycles: this.cycleCount, totalSpent: this.totalSpentSats },
      "Analyst agent stopped",
    );
  }

  getIdentityKey(): string {
    return this.identityKey;
  }

  getStats(): {
    cycles: number;
    totalSpentSats: number;
    lastAnalysis: FleetAnalysis | null;
  } {
    return {
      cycles: this.cycleCount,
      totalSpentSats: this.totalSpentSats,
      lastAnalysis: this.lastAnalysis,
    };
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
          "analyst",
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

      await this.activityPub.publishMessage(
        "analyst",
        "collector",
        "data_request",
        "Requesting fleet_snapshot",
      );
      agentMessagesTotal.inc({ agent: "analyst", direction: "outbound" });

      const requestId = `req_${Date.now()}_${this.cycleCount}`;
      const response = await this.collector.fulfilRequest({
        requestId,
        product: "fleet_snapshot",
        requesterKey: this.identityKey,
      });

      agentMessagesTotal.inc({ agent: "analyst", direction: "inbound" });

      const price = getPrice("fleet_snapshot");
      if (this.collectorKey && price > 0) {
        try {
          await this.wallet.sendMessageBoxPayment(this.collectorKey, price);
          this.totalSpentSats += price;
          agentPaymentsTotal.inc({
            from_agent: "analyst",
            to_agent: "collector",
            product: "fleet_snapshot",
          });

          await this.activityPub.publishTransaction(
            "analyst",
            "data_purchase",
            price,
            "fleet_snapshot",
            this.collectorKey,
          );
        } catch (err) {
          log.debug({ err }, "MessageBox payment failed (non-fatal, continuing analysis)");
          await this.activityPub.publishTransaction(
            "analyst",
            "data_purchase_attempt",
            price,
            "fleet_snapshot",
            this.collectorKey,
          );
        }
      }

      const fleetData = response.data as Record<string, TelemetryRecord> | null;
      if (fleetData && typeof fleetData === "object") {
        const records = Object.values(fleetData);
        if (records.length > 0) {
          const analysis = analyseFleet(records);
          this.lastAnalysis = analysis;
          const summary = summariseAnalysis(analysis);

          const inscription = await inscribeAgentRecord({
            db: this.db,
            sink: this.sink,
            agentLabel: "analyst",
            recordType: RecordType.AGENT_ANALYSIS,
            record: buildAnalysisRecord(analysis, summary),
          });

          if (inscription) {
            this.lastInscriptionAt = Date.now();
            this.consecutiveInscriptionFailures = 0;
            analysisPublishedTotal.inc();
          } else {
            this.consecutiveInscriptionFailures++;
          }

          await this.activityPub.publishAnalysis(
            "analyst",
            summary,
            inscription?.txid ?? "failed",
            {
              airborne: analysis.airborne,
              grounded: analysis.grounded,
              anomalies: analysis.anomalies.length,
              inscribed: inscription !== null,
            },
          );
        }
      }
      this.lastCycleAt = Date.now();
    } catch (err) {
      log.error({ err, cycle: this.cycleCount }, "Analysis cycle failed");
    }

    this.scheduleNextCycle();
  }
}
