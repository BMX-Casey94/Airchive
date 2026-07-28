import { Hash, P2PKH, PrivateKey, Script, Transaction, ARC } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "agent-marketplace:direct-pay" });

const SATS_PER_KB = 100;
const FEE_BUFFER = 1.15;
const P2PKH_UNLOCK_SIZE = 107;
const P2PKH_OUTPUT_SIZE = 34;
const TX_OVERHEAD = 10;
const INPUT_OVERHEAD = 41;
const MIN_CHANGE_SATS = 546;

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

function derivePkh(key: PrivateKey): number[] {
  return Hash.hash160(key.toPublicKey().encode(true) as number[]);
}

function varintLen(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  return 5;
}

function appendPush(script: number[], data: Uint8Array): void {
  const n = data.length;
  if (n <= 0x4b) {
    script.push(n);
  } else if (n <= 0xff) {
    script.push(0x4c, n);
  } else if (n <= 0xffff) {
    script.push(0x4d, n & 0xff, (n >> 8) & 0xff);
  } else {
    script.push(0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  }
  for (let i = 0; i < n; i++) script.push(data[i]!);
}

function buildTextOpReturn(data: Uint8Array): number[] {
  const script: number[] = [0x00, 0x6a];
  appendPush(script, data);
  return script;
}

function estimateFee(inputCount: number, outputCount: number): number {
  const size =
    TX_OVERHEAD +
    1 +
    (INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE) * inputCount +
    P2PKH_OUTPUT_SIZE * outputCount;
  return Math.ceil((size / 1000) * SATS_PER_KB * FEE_BUFFER);
}

interface ArcBroadcastResult {
  status?: string;
  code?: string;
  txid?: string;
  description?: string;
}

/**
 * ARC returns `status: "error"` for SEEN_IN_ORPHAN_MEMPOOL even when it stored
 * the transaction under a txid. Treating that as a hard failure made agents
 * retry immediately, burn the only UTXO, then report `best 0` forever.
 */
function acceptedBroadcast(result: ArcBroadcastResult): string | null {
  if (!result.txid) return null;
  const code = String(result.code ?? "").trim().toUpperCase();
  if (code === "SEEN_IN_ORPHAN_MEMPOOL" || code === "SEEN_ON_NETWORK") {
    return result.txid;
  }
  if (result.status === "error") return null;
  return result.txid;
}

export class DirectPaymentSender {
  private readonly wocUrl: string;
  private readonly arc: ARC;
  private readonly keys = new Map<string, PrivateKey>();
  /** Outpoints we have already spent locally — WoC lags behind mempool spends. */
  private readonly recentlySpent = new Map<string, number>();
  private static readonly SPENT_TTL_MS = 15 * 60_000;

  constructor(wocApiUrl: string, arcUrl: string, arcApiKey: string) {
    this.wocUrl = wocApiUrl;
    this.arc = new ARC(arcUrl, {
      apiKey: arcApiKey,
      httpClient: {
        async request<D>(url: string, options: { method?: string; headers?: Record<string, string>; data?: unknown }) {
          const res = await fetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.data != null ? JSON.stringify(options.data) : undefined,
          });
          const mediaType = res.headers.get("Content-Type");
          const data = mediaType?.startsWith("application/json")
            ? await res.json()
            : await res.text();
          return { ok: res.ok, status: res.status, statusText: res.statusText, data: data as D };
        },
      },
    });
  }

  private outpointKey(txHash: string, pos: number): string {
    return `${txHash}:${pos}`;
  }

  private rememberSpend(txHash: string, pos: number): void {
    this.recentlySpent.set(this.outpointKey(txHash, pos), Date.now());
  }

  private pruneSpent(): void {
    const cutoff = Date.now() - DirectPaymentSender.SPENT_TTL_MS;
    for (const [key, at] of this.recentlySpent) {
      if (at < cutoff) this.recentlySpent.delete(key);
    }
  }

  registerKey(label: string, hexKey: string): void {
    if (!hexKey) {
      log.warn({ label }, "Skipping key registration — empty hex key");
      return;
    }
    const pk = PrivateKey.fromString(hexKey, 16);
    this.keys.set(label, pk);
    log.info({ label, address: pk.toAddress() }, "Registered direct-pay key");
  }

  getAddress(label: string): string {
    const pk = this.keys.get(label);
    if (!pk) throw new Error(`Unknown key label: ${label}`);
    return pk.toAddress();
  }

  async sendPayment(
    fromLabel: string,
    toLabel: string,
    amountSats: number,
  ): Promise<{ txid: string; feeSats: number }> {
    const senderKey = this.keys.get(fromLabel);
    const recipientKey = this.keys.get(toLabel);
    if (!senderKey) throw new Error(`Unknown sender: ${fromLabel}`);
    if (!recipientKey) throw new Error(`Unknown recipient: ${toLabel}`);

    const senderAddress = senderKey.toAddress();
    const utxos = await this.fetchSpendableUtxos(senderAddress);

    const fee = estimateFee(1, 2);
    const needed = amountSats + fee + MIN_CHANGE_SATS;
    const suitable = pickUtxo(utxos, needed);
    if (!suitable) {
      const best = Math.max(0, ...utxos.map((u) => u.value));
      throw new Error(`No suitable UTXO for ${fromLabel}: need ${needed}, best ${best}`);
    }

    const changeSats = suitable.value - amountSats - fee;

    const senderPkh = derivePkh(senderKey);
    const senderLock = new P2PKH().lock(senderPkh);
    const recipientPkh = derivePkh(recipientKey);
    const recipientLock = new P2PKH().lock(recipientPkh);

    const tx = new Transaction();
    tx.addInput({
      sourceTXID: suitable.tx_hash,
      sourceOutputIndex: suitable.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(
        senderKey, "all", false, suitable.value, senderLock,
      ),
      sequence: 0xffffffff,
    });

    tx.addOutput({ lockingScript: recipientLock, satoshis: amountSats });

    if (changeSats >= MIN_CHANGE_SATS) {
      tx.addOutput({ lockingScript: senderLock, satoshis: changeSats });
    }

    await tx.sign();

    const result = (await this.arc.broadcast(tx)) as ArcBroadcastResult;
    const txid = acceptedBroadcast(result);
    if (!txid) {
      throw new Error(`Broadcast failed: ${JSON.stringify(result)}`);
    }
    this.rememberSpend(suitable.tx_hash, suitable.tx_pos);

    const orphan = String(result.code ?? "").toUpperCase() === "SEEN_IN_ORPHAN_MEMPOOL";
    log.info(
      { from: fromLabel, to: toLabel, amount: amountSats, txid, fee, orphan },
      orphan
        ? "Direct P2PKH payment accepted into orphan mempool (parent still propagating)"
        : "Direct P2PKH payment sent",
    );

    return { txid, feeSats: fee };
  }

  async inscribe(
    fromLabel: string,
    text: string,
  ): Promise<{ txid: string; feeSats: number }> {
    return this.inscribeScript(fromLabel, buildTextOpReturn(new TextEncoder().encode(text)));
  }

  /**
   * Inscribes a prebuilt OP_RETURN script, which is how agent records carry the
   * AIRCHIVE header rather than a bare JSON blob no parser recognises.
   */
  async inscribeScript(
    fromLabel: string,
    scriptBytes: number[],
  ): Promise<{ txid: string; feeSats: number; sizeBytes: number }> {
    const senderKey = this.keys.get(fromLabel);
    if (!senderKey) throw new Error(`Unknown sender: ${fromLabel}`);

    const senderAddress = senderKey.toAddress();
    const utxos = await this.fetchSpendableUtxos(senderAddress);

    const opReturnScript = Script.fromBinary(scriptBytes);

    const opReturnOutputSize = 8 + varintLen(scriptBytes.length) + scriptBytes.length;
    const txSize =
      TX_OVERHEAD + 1 +
      (INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE) +
      opReturnOutputSize +
      P2PKH_OUTPUT_SIZE;
    const fee = Math.ceil((txSize / 1000) * SATS_PER_KB * FEE_BUFFER);
    const needed = fee + MIN_CHANGE_SATS;

    const suitable = pickUtxo(utxos, needed);
    if (!suitable) {
      const best = Math.max(0, ...utxos.map((u) => u.value));
      throw new Error(`No suitable UTXO for ${fromLabel} inscription: need ${needed}, best ${best}`);
    }

    const changeSats = suitable.value - fee;

    const senderPkh = derivePkh(senderKey);
    const senderLock = new P2PKH().lock(senderPkh);

    const tx = new Transaction();
    tx.addInput({
      sourceTXID: suitable.tx_hash,
      sourceOutputIndex: suitable.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(
        senderKey, "all", false, suitable.value, senderLock,
      ),
      sequence: 0xffffffff,
    });

    tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });

    if (changeSats >= MIN_CHANGE_SATS) {
      tx.addOutput({ lockingScript: senderLock, satoshis: changeSats });
    }

    await tx.sign();

    const result = (await this.arc.broadcast(tx)) as ArcBroadcastResult;
    const txid = acceptedBroadcast(result);
    if (!txid) {
      throw new Error(`Inscription broadcast failed: ${JSON.stringify(result)}`);
    }
    this.rememberSpend(suitable.tx_hash, suitable.tx_pos);

    const orphan = String(result.code ?? "").toUpperCase() === "SEEN_IN_ORPHAN_MEMPOOL";
    log.info(
      { from: fromLabel, txid, fee, scriptLen: scriptBytes.length, orphan },
      orphan
        ? "Direct OP_RETURN inscription accepted into orphan mempool"
        : "Direct OP_RETURN inscription sent",
    );

    return { txid, feeSats: fee, sizeBytes: tx.toBinary().length };
  }

  private async fetchSpendableUtxos(address: string): Promise<WocUtxo[]> {
    this.pruneSpent();
    const res = await fetch(`${this.wocUrl}/address/${address}/unspent`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const utxos = (await res.json()) as WocUtxo[];
    return utxos.filter(
      (u) => !this.recentlySpent.has(this.outpointKey(u.tx_hash, u.tx_pos)),
    );
  }
}

/** Prefer confirmed UTXOs so agent chains do not keep landing in the orphan mempool. */
function pickUtxo(utxos: WocUtxo[], needed: number): WocUtxo | undefined {
  const funded = utxos.filter((u) => u.value >= needed);
  if (funded.length === 0) return undefined;
  const confirmed = funded.filter((u) => u.height > 0);
  const pool = confirmed.length > 0 ? confirmed : funded;
  return pool.sort((a, b) => a.value - b.value)[0];
}
