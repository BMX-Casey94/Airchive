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

export class DirectPaymentSender {
  private readonly wocUrl: string;
  private readonly arc: ARC;
  private readonly keys = new Map<string, PrivateKey>();

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
    const utxos = await this.fetchUtxos(senderAddress);

    const fee = estimateFee(1, 2);
    const needed = amountSats + fee + MIN_CHANGE_SATS;
    const suitable = utxos.find((u) => u.value >= needed);
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
      sourceSatoshis: suitable.value,
      lockingScript: senderLock,
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

    const result = await this.arc.broadcast(tx);
    if (result.status === "error" || !result.txid) {
      throw new Error(`Broadcast failed: ${JSON.stringify(result)}`);
    }

    log.info(
      { from: fromLabel, to: toLabel, amount: amountSats, txid: result.txid, fee },
      "Direct P2PKH payment sent",
    );

    return { txid: result.txid, feeSats: fee };
  }

  async inscribe(
    fromLabel: string,
    text: string,
  ): Promise<{ txid: string; feeSats: number }> {
    const senderKey = this.keys.get(fromLabel);
    if (!senderKey) throw new Error(`Unknown sender: ${fromLabel}`);

    const senderAddress = senderKey.toAddress();
    const utxos = await this.fetchUtxos(senderAddress);

    const dataBytes = new TextEncoder().encode(text);
    const scriptBytes = buildTextOpReturn(dataBytes);
    const opReturnScript = Script.fromBinary(scriptBytes);

    const opReturnOutputSize = 8 + varintLen(scriptBytes.length) + scriptBytes.length;
    const txSize =
      TX_OVERHEAD + 1 +
      (INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE) +
      opReturnOutputSize +
      P2PKH_OUTPUT_SIZE;
    const fee = Math.ceil((txSize / 1000) * SATS_PER_KB * FEE_BUFFER);
    const needed = fee + MIN_CHANGE_SATS;

    const suitable = utxos.find((u) => u.value >= needed);
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
      sourceSatoshis: suitable.value,
      lockingScript: senderLock,
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

    const result = await this.arc.broadcast(tx);
    if (result.status === "error" || !result.txid) {
      throw new Error(`Inscription broadcast failed: ${JSON.stringify(result)}`);
    }

    log.info(
      { from: fromLabel, txid: result.txid, fee, dataLen: dataBytes.length },
      "Direct OP_RETURN inscription sent",
    );

    return { txid: result.txid, feeSats: fee };
  }

  private async fetchUtxos(address: string): Promise<WocUtxo[]> {
    const res = await fetch(`${this.wocUrl}/address/${address}/unspent`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    return (await res.json()) as WocUtxo[];
  }
}
