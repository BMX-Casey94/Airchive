import { Hash, P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import type {
  FlightEventRecord,
  TelemetryRecord,
  UTXORecord,
} from "@airchive/types";
import { RecordType } from "@airchive/types";
import {
  buildOpReturnPayload,
  buildOpReturnScript,
  encodeFlightEventPayload,
  encodeTelemetryPayload,
  CHRONICLE_TX_VERSION,
} from "@airchive/telemetry-codec";

const SATS_PER_KB = 100;
const FEE_BUFFER = 1.1;
const P2PKH_UNLOCK_SIZE = 107;
const P2PKH_OUTPUT_SIZE = 34;
const TX_OVERHEAD = 10; // version(4) + in_count(1) + out_count(1) + locktime(4)
const INPUT_OVERHEAD = 41; // txid(32) + vout(4) + varint(1) + sequence(4)

export interface BuildResult {
  tx: Transaction;
  changeOutput: {
    satoshis: number;
    lockingScript: string;
    isChronicle?: boolean;
  };
  /**
   * The flat AIRCHIVE envelope carried in the OP_RETURN. Persisted with the
   * transaction so history can be decoded without refetching from a miner.
   */
  opReturn?: Uint8Array;
}

export function derivePubKeyHash(key: PrivateKey): number[] {
  return Hash.hash160(key.toPublicKey().encode(true) as number[]);
}

function varintSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

export function estimateConsolidationSize(inputCount: number): number {
  const inputSize = INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE;
  return (
    TX_OVERHEAD +
    varintSize(inputCount) +
    inputSize * inputCount +
    P2PKH_OUTPUT_SIZE
  );
}

export function calculateFee(estimatedBytes: number): number {
  return Math.ceil((estimatedBytes / 1000) * SATS_PER_KB * FEE_BUFFER);
}

interface SpendableOutputRef {
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
}

function buildSourceTransaction(output: SpendableOutputRef): Transaction {
  const sourceTx = new Transaction();
  for (let vout = 0; vout < output.vout; vout++) {
    sourceTx.addOutput({
      lockingScript: Script.fromBinary([]),
      satoshis: 0,
    });
  }
  sourceTx.addOutput({
    lockingScript: Script.fromHex(output.lockingScript),
    satoshis: output.satoshis,
  });
  return sourceTx;
}

function addSpendableInput(
  tx: Transaction,
  spend: SpendableOutputRef,
  privateKey: PrivateKey,
): void {
  const inputLockScript = Script.fromHex(spend.lockingScript);
  tx.addInput({
    sourceTransaction: buildSourceTransaction(spend),
    sourceTXID: spend.txid,
    sourceOutputIndex: spend.vout,
    unlockingScriptTemplate: new P2PKH().unlock(
      privateKey,
      "all",
      false,
      spend.satoshis,
      inputLockScript,
    ),
    sequence: 0xffffffff,
  });
}

async function buildOpReturnTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  scriptBytes: number[];
  opReturn?: Uint8Array;
  useChronicleVersion?: boolean;
}): Promise<BuildResult> {
  const { utxo, privateKey, scriptBytes, opReturn, useChronicleVersion } = params;
  const inputSats = Number(utxo.satoshis);
  const pkh = derivePubKeyHash(privateKey);
  const changeLockScript = new P2PKH().lock(pkh);

  const inputSize = INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE;
  const opReturnOutputSize = 8 + varintSize(scriptBytes.length) + scriptBytes.length;
  const estSize = TX_OVERHEAD + varintSize(1) + inputSize + opReturnOutputSize + P2PKH_OUTPUT_SIZE;
  const fee = calculateFee(estSize);
  const changeSats = inputSats - fee;

  if (changeSats < 1) {
    throw new Error(
      `Insufficient UTXO balance: ${inputSats} sats, fee ${fee} sats`,
    );
  }

  const tx = new Transaction();
  tx.version = useChronicleVersion ? CHRONICLE_TX_VERSION : 1;

  addSpendableInput(tx, {
    txid: utxo.txid,
    vout: utxo.vout,
    satoshis: inputSats,
    lockingScript: utxo.locking_script,
  }, privateKey);

  tx.addOutput({
    lockingScript: Script.fromBinary(scriptBytes),
    satoshis: 0,
  });

  tx.addOutput({
    lockingScript: changeLockScript,
    satoshis: changeSats,
  });

  await tx.sign();

  return {
    tx,
    changeOutput: {
      satoshis: changeSats,
      lockingScript: changeLockScript.toHex(),
      isChronicle: !!useChronicleVersion,
    },
    opReturn,
  };
}

export async function buildTelemetryTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  telemetry: TelemetryRecord;
  recordType: RecordType;
}): Promise<BuildResult> {
  const payloadBytes = encodeTelemetryPayload(params.telemetry);
  const recordType = params.recordType as 0x01 | 0x02 | 0x03;
  const scriptBytes = buildOpReturnScript(
    params.telemetry.icao,
    params.telemetry.ts,
    recordType,
    payloadBytes,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
    opReturn: buildOpReturnPayload(
      params.telemetry.icao,
      params.telemetry.ts,
      recordType,
      payloadBytes,
    ),
    useChronicleVersion: true,
  });
}

export async function buildFlightEventTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  event: FlightEventRecord;
}): Promise<BuildResult> {
  const payloadBytes = encodeFlightEventPayload(params.event);
  // Captured once so the script and the persisted envelope cannot disagree.
  const timestamp = Date.now();
  const scriptBytes = buildOpReturnScript(
    params.event.icao,
    timestamp,
    0x02 as 0x01 | 0x02 | 0x03,
    payloadBytes,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
    opReturn: buildOpReturnPayload(
      params.event.icao,
      timestamp,
      0x02 as 0x01 | 0x02 | 0x03,
      payloadBytes,
    ),
    useChronicleVersion: true,
  });
}

export function computeTxid(tx: Transaction): string {
  try {
    const id = (tx as unknown as { id?: (enc: string) => string }).id?.("hex");
    if (typeof id === "string" && id.length === 64) return id;
  } catch { /* fall through to manual derivation */ }

  const raw = tx.toBinary();
  const hash = Hash.hash256(raw as number[]) as number[];
  return hash
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildRawOpReturnTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  icao: string;
  timestamp: number;
  recordType: RecordType;
  payload: Uint8Array;
}): Promise<BuildResult> {
  const recordType = params.recordType as 0x01 | 0x02 | 0x03;
  const scriptBytes = buildOpReturnScript(
    params.icao,
    params.timestamp,
    recordType,
    params.payload,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
    opReturn: buildOpReturnPayload(
      params.icao,
      params.timestamp,
      recordType,
      params.payload,
    ),
  });
}

export async function buildConsolidationTx(
  utxos: UTXORecord[],
  privateKey: PrivateKey,
): Promise<BuildResult> {
  const fee = calculateFee(estimateConsolidationSize(utxos.length));
  let totalSats = 0;
  for (const u of utxos) totalSats += Number(u.satoshis);

  const changeSats = totalSats - fee;
  if (changeSats < 1) {
    throw new Error(
      `Consolidation not viable: total ${totalSats} sats, fee ${fee} sats`,
    );
  }

  const pkh = derivePubKeyHash(privateKey);
  const changeLockScript = new P2PKH().lock(pkh);
  const tx = new Transaction();

  for (const utxo of utxos) {
    addSpendableInput(tx, {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: Number(utxo.satoshis),
      lockingScript: utxo.locking_script,
    }, privateKey);
  }

  tx.addOutput({
    lockingScript: changeLockScript,
    satoshis: changeSats,
  });

  await tx.sign();

  return {
    tx,
    changeOutput: {
      satoshis: changeSats,
      lockingScript: changeLockScript.toHex(),
    },
  };
}

export interface RefillResult {
  tx: Transaction;
  recipientOutputs: Array<{
    vout: number;
    satoshis: number;
    lockingScript: string;
  }>;
  changeVout: number | null;
  changeSats: number;
  changeLockingScript: string | null;
}

const REFILL_OUTPUT_DUST_LIMIT = 546;

export function estimateRefillFee(
  recipientOutputCount: number,
  includeChange = true,
  inputCount = 1,
): number {
  const safeRecipientCount = Math.max(1, Math.floor(recipientOutputCount));
  const safeInputCount = Math.max(1, Math.floor(inputCount));
  const outputCount = safeRecipientCount + (includeChange ? 1 : 0);
  const estSize =
    TX_OVERHEAD +
    varintSize(safeInputCount) +
    (INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE) * safeInputCount +
    (P2PKH_OUTPUT_SIZE * outputCount);
  return calculateFee(estSize);
}

export interface FundingInput {
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
}

/**
 * Builds a treasury → aircraft refill. Multiple funding inputs are supported
 * because a heavily split treasury can hold plenty of value overall while no
 * single output covers a refill on its own; requiring one large UTXO in that
 * state stalls every write despite the money being there.
 */
export async function buildRefillTx(params: {
  fundingUtxos: FundingInput[];
  fundingKey: PrivateKey;
  recipientPkh: number[];
  amountSats: number;
  recipientOutputCount?: number;
}): Promise<RefillResult> {
  const {
    fundingUtxos,
    fundingKey,
    recipientPkh,
    amountSats,
    recipientOutputCount = 1,
  } = params;
  if (fundingUtxos.length === 0) {
    throw new Error("Refill requires at least one funding UTXO");
  }
  const inputSats = fundingUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
  const safeRecipientCount = Math.max(1, Math.floor(recipientOutputCount));
  const fee = estimateRefillFee(safeRecipientCount, true, fundingUtxos.length);

  const changeSats = inputSats - amountSats - fee;
  if (changeSats < 0) {
    throw new Error(
      `Funding UTXOs insufficient: ${inputSats} sats across ${fundingUtxos.length} `
        + `input(s) for ${amountSats} + ${fee} fee`,
    );
  }

  const fundingPkh = derivePubKeyHash(fundingKey);
  const changeLockScript = new P2PKH().lock(fundingPkh);
  const recipientLockScript = new P2PKH().lock(recipientPkh);
  const tx = new Transaction();

  for (const utxo of fundingUtxos) {
    addSpendableInput(tx, {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingScript: utxo.lockingScript,
    }, fundingKey);
  }

  const baseRecipientSats = Math.floor(amountSats / safeRecipientCount);
  const remainder = amountSats % safeRecipientCount;
  if (baseRecipientSats < REFILL_OUTPUT_DUST_LIMIT) {
    throw new Error(
      `Refill split would create dust outputs: ${amountSats} sats across ${safeRecipientCount} outputs`,
    );
  }

  const recipientOutputs: RefillResult["recipientOutputs"] = [];
  for (let i = 0; i < safeRecipientCount; i++) {
    const recipientSats = baseRecipientSats + (i < remainder ? 1 : 0);
    tx.addOutput({
      lockingScript: recipientLockScript,
      satoshis: recipientSats,
    });
    recipientOutputs.push({
      vout: i,
      satoshis: recipientSats,
      lockingScript: recipientLockScript.toHex(),
    });
  }

  let changeVout: number | null = null;
  let changeLockingScriptHex: string | null = null;
  if (changeSats >= REFILL_OUTPUT_DUST_LIMIT) {
    tx.addOutput({
      lockingScript: changeLockScript,
      satoshis: changeSats,
    });
    changeVout = recipientOutputs.length;
    changeLockingScriptHex = changeLockScript.toHex();
  }

  await tx.sign();

  return {
    tx,
    recipientOutputs,
    changeVout,
    changeSats: changeVout !== null ? changeSats : 0,
    changeLockingScript: changeLockingScriptHex,
  };
}

export interface FundingSplitResult {
  tx: Transaction;
  outputs: Array<{ vout: number; satoshis: number; lockingScript: string }>;
}

/**
 * Reshapes the treasury: spends one or more funding outputs back to the funding
 * address as `targetOutputCount` equal outputs. One input with many outputs is a
 * split; many inputs with one output is a consolidation. Both are the same
 * transaction shape, so they share a builder.
 */
export async function buildFundingSplitTx(params: {
  fundingUtxos: FundingInput[];
  fundingKey: PrivateKey;
  targetOutputCount: number;
}): Promise<FundingSplitResult> {
  const { fundingUtxos, fundingKey, targetOutputCount } = params;
  if (fundingUtxos.length === 0) {
    throw new Error("Funding reshape requires at least one input");
  }
  const inputSats = fundingUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
  const safeCount = Math.max(1, Math.min(targetOutputCount, 50));
  const fee = estimateRefillFee(safeCount, false, fundingUtxos.length);
  const availableSats = inputSats - fee;
  if (availableSats < safeCount * REFILL_OUTPUT_DUST_LIMIT) {
    throw new Error(
      `Cannot reshape funding UTXOs: ${inputSats} sats across `
        + `${fundingUtxos.length} input(s) is too small for ${safeCount} outputs`,
    );
  }

  const baseSats = Math.floor(availableSats / safeCount);
  const remainder = availableSats % safeCount;

  const fundingPkh = derivePubKeyHash(fundingKey);
  const lockScript = new P2PKH().lock(fundingPkh);
  const lockScriptHex = lockScript.toHex();
  const tx = new Transaction();

  for (const utxo of fundingUtxos) {
    addSpendableInput(tx, {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingScript: utxo.lockingScript,
    }, fundingKey);
  }

  const outputs: FundingSplitResult["outputs"] = [];
  for (let i = 0; i < safeCount; i++) {
    const sats = baseSats + (i < remainder ? 1 : 0);
    tx.addOutput({ lockingScript: lockScript, satoshis: sats });
    outputs.push({ vout: i, satoshis: sats, lockingScript: lockScriptHex });
  }

  await tx.sign();
  return { tx, outputs };
}
