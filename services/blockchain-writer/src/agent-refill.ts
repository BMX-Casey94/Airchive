import { PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import type { Config } from "./config.js";
import {
  BroadcastPriority,
  isDependencyPendingBroadcastFailure,
  isTransientBroadcastFailure,
  type Broadcaster,
} from "./broadcaster.js";
import type { FundingUtxoManager } from "./funding-utxo-manager.js";
import { buildRefillTx, derivePubKeyHash, estimateRefillFee } from "./tx-builder.js";
import {
  agentRefillOutcomesTotal,
  agentWalletBalance,
  spendBlockedTotal,
} from "./metrics.js";
import type { ChainLookup } from "./chain-lookup.js";
import { isWocUnavailable } from "./woc-client.js";

const log = createLogger({ service: "blockchain-writer:agent-refill" });

/** Matches the cap the aircraft refill path uses, for the same reasons. */
const MAX_REFILL_INPUTS = 12;
const REFILL_COOLDOWN_MS = 30_000;

export type AgentRefillOutcome =
  | "refilled"
  | "sufficient"
  | "treasury_dry"
  | "chain_unavailable"
  | "cooldown"
  | "broadcast_deferred"
  | "broadcast_failed"
  | "error";

export interface AgentWalletTarget {
  label: string;
  address: string;
  pkh: number[];
}

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

/**
 * Derives the marketplace agents' P2PKH wallets from the same hex keys the
 * agent-marketplace service uses, so the writer can top them up without either
 * service holding the other's secrets.
 */
export function resolveAgentTargets(): AgentWalletTarget[] {
  const envByLabel: Array<[string, string]> = [
    ["collector", "COLLECTOR_AGENT_KEY"],
    ["analyst", "ANALYST_AGENT_KEY"],
    ["monitor", "MONITOR_AGENT_KEY"],
  ];

  const targets: AgentWalletTarget[] = [];
  for (const [label, envVar] of envByLabel) {
    const hexKey = process.env[envVar]?.trim();
    if (!hexKey) {
      log.warn(
        { agent: label, envVar },
        "Agent key not set — this agent cannot be funded from the treasury and "
          + "will stop inscribing once its wallet empties",
      );
      continue;
    }
    try {
      const key = PrivateKey.fromString(hexKey, 16);
      targets.push({ label, address: key.toAddress(), pkh: derivePubKeyHash(key) });
    } catch (err) {
      log.error({ agent: label, err: (err as Error).message }, "Agent key is not valid hex");
    }
  }
  return targets;
}

/**
 * Keeps the three marketplace agent wallets funded from the treasury.
 *
 * The agents were previously fundable only by hand, so the analyst spent its
 * last output and then reported an inscription failure every cycle while the
 * treasury held millions of satoshis. Top-ups deliberately arrive as many small
 * outputs rather than one large one: each inscription spends a single output,
 * and an agent working from one output has to chain unconfirmed spends, which
 * lands the whole sequence in the orphan mempool.
 */
export class AgentWalletRefiller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly cooldowns = new Map<string, number>();
  private spendGate: (() => boolean) | null = null;

  constructor(
    private readonly config: Config,
    private readonly broadcaster: Broadcaster,
    private readonly fundingUtxoManager: FundingUtxoManager,
    private readonly targets: AgentWalletTarget[],
    private readonly woc: ChainLookup,
  ) {}

  start(): void {
    if (this.targets.length === 0) {
      log.warn("No agent wallets resolved — treasury top-ups for agents are disabled");
      return;
    }
    if (!this.config.agentRefill.enabled) {
      log.info("Agent treasury top-ups disabled by configuration");
      return;
    }

    this.intervalId = setInterval(() => {
      void this.checkAll().catch((err) => log.error({ err }, "Agent refill cycle error"));
    }, this.config.agentRefill.checkIntervalMs);

    log.info(
      {
        agents: this.targets.map((t) => ({ agent: t.label, address: t.address })),
        thresholdSats: this.config.agentRefill.thresholdSats,
        amountSats: this.config.agentRefill.amountSats,
        outputs: this.config.agentRefill.outputCount,
        intervalMs: this.config.agentRefill.checkIntervalMs,
      },
      "Agent wallet refiller started (treasury → marketplace agents)",
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Supplies the spend governor's verdict; a top-up is a treasury spend too. */
  setSpendGate(gate: () => boolean): void {
    this.spendGate = gate;
  }

  async checkAll(): Promise<void> {
    if (this.running) return;

    if (this.spendGate !== null && this.spendGate() === false) {
      spendBlockedTotal.inc({ site: "agent_refill" });
      log.warn("Agent top-up cycle skipped — spending is halted by the governor");
      return;
    }

    this.running = true;
    try {
      for (const target of this.targets) {
        try {
          const outcome = await this.checkAndRefill(target);
          agentRefillOutcomesTotal.inc({ agent: target.label, outcome });
        } catch (err) {
          // A rate-limited chain lookup is a deferral, not a fault: the next
          // cycle retries, and logging it as an error buries real failures.
          if (isWocUnavailable(err)) {
            agentRefillOutcomesTotal.inc({ agent: target.label, outcome: "chain_unavailable" });
            log.debug(
              { agent: target.label, reason: (err as Error).message },
              "Agent balance check deferred — WhatsOnChain unavailable",
            );
            continue;
          }
          agentRefillOutcomesTotal.inc({ agent: target.label, outcome: "error" });
          log.error({ err, agent: target.label }, "Agent refill failed");
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async checkAndRefill(target: AgentWalletTarget): Promise<AgentRefillOutcome> {
    const cooldownUntil = this.cooldowns.get(target.label) ?? 0;
    if (Date.now() < cooldownUntil) return "cooldown";

    const utxos = await this.fetchUtxos(target.address);
    const balance = utxos.reduce((sum, u) => sum + u.value, 0);
    // An agent inscription spends one output and needs enough in it to cover the
    // fee and leave non-dust change, so a large balance in too few outputs is
    // still a stalled agent. Count only outputs it can actually use.
    const usable = utxos.filter((u) => u.value >= this.config.agentRefill.minOutputSats).length;

    agentWalletBalance.set({ agent: target.label }, balance);

    const needsTopUp =
      balance < this.config.agentRefill.thresholdSats
      || usable < this.config.agentRefill.minUsableOutputs;
    if (!needsTopUp) return "sufficient";

    log.info(
      {
        agent: target.label,
        address: target.address,
        balance,
        usableOutputs: usable,
        thresholdSats: this.config.agentRefill.thresholdSats,
      },
      "Agent wallet below target — topping up from treasury",
    );

    return this.refill(target);
  }

  private async refill(target: AgentWalletTarget): Promise<AgentRefillOutcome> {
    const amountSats = this.config.agentRefill.amountSats;
    const outputCount = this.config.agentRefill.outputCount;
    const fundingKey = PrivateKey.fromWif(this.config.fundingWalletWif);

    const { utxos: fundingUtxos, diagnostics } = await this.fundingUtxoManager.acquireMany(
      amountSats + 100,
      MAX_REFILL_INPUTS,
      (inputCount) => estimateRefillFee(outputCount, true, inputCount),
    );

    if (fundingUtxos.length === 0) {
      log.error(
        { agent: target.label, required: amountSats, ...diagnostics },
        "Treasury could not fund an agent top-up",
      );
      this.cooldowns.set(target.label, Date.now() + REFILL_COOLDOWN_MS);
      return "treasury_dry";
    }

    const spentInputs = fundingUtxos.map((u) => ({ txid: u.txid.trim(), vout: u.vout }));

    try {
      const { tx, recipientOutputs, changeVout, changeSats, changeLockingScript } =
        await buildRefillTx({
          fundingUtxos: fundingUtxos.map((u) => ({
            txid: u.txid.trim(),
            vout: u.vout,
            satoshis: Number(u.satoshis),
            lockingScript: u.locking_script,
          })),
          fundingKey,
          recipientPkh: target.pkh,
          amountSats,
          recipientOutputCount: outputCount,
        });

      const result = await this.broadcaster.broadcast(tx, `AGENT:${target.label}`, {
        kind: "refill",
        priority: BroadcastPriority.REFILL,
      });

      if (result.status === "FAILED") {
        const deferrable =
          isDependencyPendingBroadcastFailure(result) || isTransientBroadcastFailure(result);
        await this.fundingUtxoManager.releaseMany(spentInputs);
        this.cooldowns.set(target.label, Date.now() + REFILL_COOLDOWN_MS);

        if (deferrable) {
          log.warn(
            { agent: target.label, code: result.code },
            "Agent top-up deferred — funding inputs released",
          );
          return "broadcast_deferred";
        }

        log.error(
          { agent: target.label, code: result.code, description: result.description },
          "Agent top-up rejected — agent remains unfunded",
        );
        return "broadcast_failed";
      }

      await this.fundingUtxoManager.recordSpendMany(
        spentInputs,
        changeVout !== null ? result.txid : null,
        changeVout,
        changeSats > 0 ? changeSats : null,
        changeLockingScript,
      );

      log.info(
        {
          agent: target.label,
          address: target.address,
          txid: result.txid,
          amountSats,
          outputs: recipientOutputs.length,
        },
        "Agent wallet topped up from treasury",
      );
      this.cooldowns.set(target.label, Date.now() + REFILL_COOLDOWN_MS);
      return "refilled";
    } catch (err) {
      await this.fundingUtxoManager.releaseMany(spentInputs);
      throw err;
    }
  }

  /**
   * Agent outputs are not tracked in the writer's pools — they belong to another
   * service — so their balance is read from the chain rather than the database.
   */
  private async fetchUtxos(address: string): Promise<WocUtxo[]> {
    const utxos = await this.woc.getJson<WocUtxo[]>(
      `/address/${address}/unspent`,
      { label: "agent_unspent", timeoutMs: 10_000 },
    );
    if (!utxos) {
      throw new Error(`WhatsOnChain returned no body for ${address}`);
    }
    return utxos;
  }
}
