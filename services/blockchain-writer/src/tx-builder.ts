import { Hash, P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import type {
  FlightEventRecord,
  TelemetryRecord,
  UTXORecord,
} from "@airchive/types";
import { RecordType } from "@airchive/types";
import {
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

async function buildOpReturnTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  scriptBytes: number[];
  useChronicleVersion?: boolean;
}): Promise<BuildResult> {
  const { utxo, privateKey, scriptBytes, useChronicleVersion } = params;
  const inputSats = Number(utxo.satoshis);
  const pkh = derivePubKeyHash(privateKey);
  const inputLockScript = Script.fromHex(utxo.locking_script);
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

  tx.addInput({
    sourceTXID: utxo.txid,
    sourceOutputIndex: utxo.vout,
    sourceSatoshis: inputSats,
    lockingScript: inputLockScript,
    unlockingScriptTemplate: new P2PKH().unlock(privateKey, "all", false, inputSats, inputLockScript),
    sequence: 0xffffffff,
  });

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
  };
}

export async function buildTelemetryTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  telemetry: TelemetryRecord;
  recordType: RecordType;
}): Promise<BuildResult> {
  const payloadBytes = encodeTelemetryPayload(params.telemetry);
  const scriptBytes = buildOpReturnScript(
    params.telemetry.icao,
    params.telemetry.ts,
    params.recordType as 0x01 | 0x02 | 0x03,
    payloadBytes,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
    useChronicleVersion: true,
  });
}

export async function buildFlightEventTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  event: FlightEventRecord;
}): Promise<BuildResult> {
  const payloadBytes = encodeFlightEventPayload(params.event);
  const scriptBytes = buildOpReturnScript(
    params.event.icao,
    Date.now(),
    0x02 as 0x01 | 0x02 | 0x03,
    payloadBytes,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
  });
}

export async function buildRawOpReturnTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  icao: string;
  timestamp: number;
  recordType: RecordType;
  payload: Uint8Array;
}): Promise<BuildResult> {
  const scriptBytes = buildOpReturnScript(
    params.icao,
    params.timestamp,
    params.recordType as 0x01 | 0x02 | 0x03,
    params.payload,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
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
    const sats = Number(utxo.satoshis);
    const lockScript = Script.fromHex(utxo.locking_script);
    tx.addInput({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      sourceSatoshis: sats,
      lockingScript: lockScript,
      unlockingScriptTemplate: new P2PKH().unlock(
        privateKey,
        "all",
        false,
        sats,
        lockScript,
      ),
      sequence: 0xffffffff,
    });
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
): number {
  const safeRecipientCount = Math.max(1, Math.floor(recipientOutputCount));
  const outputCount = safeRecipientCount + (includeChange ? 1 : 0);
  const estSize =
    TX_OVERHEAD +
    varintSize(1) +
    (INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE) +
    (P2PKH_OUTPUT_SIZE * outputCount);
  return calculateFee(estSize);
}

export async function buildRefillTx(params: {
  fundingUtxo: { txid: string; vout: number; satoshis: number; lockingScript: string };
  fundingKey: PrivateKey;
  recipientPkh: number[];
  amountSats: number;
  recipientOutputCount?: number;
}): Promise<RefillResult> {
  const {
    fundingUtxo,
    fundingKey,
    recipientPkh,
    amountSats,
    recipientOutputCount = 1,
  } = params;
  const inputSats = fundingUtxo.satoshis;
  const safeRecipientCount = Math.max(1, Math.floor(recipientOutputCount));
  const fee = estimateRefillFee(safeRecipientCount);

  const changeSats = inputSats - amountSats - fee;
  if (changeSats < 0) {
    throw new Error(
      `Funding UTXO insufficient: ${inputSats} sats for ${amountSats} + ${fee} fee`,
    );
  }

  const fundingPkh = derivePubKeyHash(fundingKey);
  const changeLockScript = new P2PKH().lock(fundingPkh);
  const recipientLockScript = new P2PKH().lock(recipientPkh);
  const tx = new Transaction();

  const fundingLockScript = Script.fromHex(fundingUtxo.lockingScript);

  tx.addInput({
    sourceTXID: fundingUtxo.txid,
    sourceOutputIndex: fundingUtxo.vout,
    sourceSatoshis: inputSats,
    lockingScript: fundingLockScript,
    unlockingScriptTemplate: new P2PKH().unlock(
      fundingKey,
      "all",
      false,
      inputSats,
      fundingLockScript,
    ),
    sequence: 0xffffffff,
  });

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
