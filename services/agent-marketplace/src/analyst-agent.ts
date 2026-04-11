import type { TelemetryRecord } from "@airchive/types";
import { createLogger } from "@airchive/logger";
import { analyseFleet, summariseAnalysis, type FleetAnalysis } from "./analysis-engine.js";
import { getPrice } from "./data-products.js";
import {
  agentPaymentsTotal,
  agentMessagesTotal,
  analysisPublishedTotal,
} from "./metrics.js";
import type { CollectorAgent } from "./collector-agent.js";
import type { AgentActivityPublisher } from "./activity-publisher.js";

const log = createLogger({ service: "analyst-agent" });

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

  constructor(
    collector: CollectorAgent,
    activityPub: AgentActivityPublisher,
    intervalMs: number,
  ) {
    this.collector = collector;
    this.activityPub = activityPub;
    this.intervalMs = intervalMs;
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
      log.warn({ err }, "Identity tag registration failed (may already exist)");
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

          try {
            const inscription = await this.wallet.inscribeText(
              JSON.stringify({
                type: "AIRCHIVE_ANALYSIS",
                version: 1,
                ts: analysis.timestamp,
                summary,
                airborne: analysis.airborne,
                grounded: analysis.grounded,
                avgAlt: analysis.avgAltitudeFt,
                avgGs: analysis.avgGroundSpeedKts,
                maxAlt: analysis.maxAltitudeFt,
                anomalyCount: analysis.anomalies.length,
                staleCount: analysis.staleAircraft.length,
                phases: analysis.phaseDistribution,
              }),
            );

            analysisPublishedTotal.inc();
            log.info(
              { txid: inscription.txid, cycle: this.cycleCount, summary },
              "Analysis published on-chain",
            );

            await this.activityPub.publishAnalysis(
              "analyst",
              summary,
              inscription.txid,
              {
                airborne: analysis.airborne,
                grounded: analysis.grounded,
                anomalies: analysis.anomalies.length,
              },
            );
          } catch (err) {
            log.debug({ err }, "On-chain inscription failed (non-fatal)");
            await this.activityPub.publishAnalysis(
              "analyst",
              summariseAnalysis(analysis),
              "pending",
              {
                airborne: analysis.airborne,
                grounded: analysis.grounded,
                anomalies: analysis.anomalies.length,
              },
            );
          }
        }
      }
    } catch (err) {
      log.error({ err, cycle: this.cycleCount }, "Analysis cycle failed");
    }

    this.scheduleNextCycle();
  }
}
