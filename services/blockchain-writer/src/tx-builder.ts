import { Hash, P2PKH, PrivateKey, Script, Transaction, TransactionSignature, UnlockingScript } from "@bsv/sdk";
import type {
  FlightEventRecord,
  TelemetryRecord,
  UTXORecord,
} from "@airchive/types";
import { RecordType } from "@airchive/types";
import {
  buildOpReturnScript,
  buildOpReturnPayload,
  encodeFlightEventPayload,
  encodeTelemetryPayload,
  buildChronicleP2PKH,
  estimateChronicleUnlockSize,
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

interface ChronicleConfig {
  icao: string;
  fullPayload: Uint8Array;
}

function createChronicleUnlockTemplate(
  privateKey: PrivateKey,
  fullPayload: Uint8Array,
  sourceSatoshis: number,
  lockingScript: Script,
) {
  return {
    sign: async (tx: Transaction, inputIndex: number) => {
      const signatureScope =
        TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL;

      const input = tx.inputs[inputIndex]!;
      const otherInputs = tx.inputs.filter((_: unknown, i: number) => i !== inputIndex);
      const sourceTXID = input.sourceTXID ?? (input as { sourceTransaction?: { id(fmt: string): string } }).sourceTransaction?.id("hex");

      const preimage = TransactionSignature.format({
        sourceTXID: sourceTXID!,
        sourceOutputIndex: input.sourceOutputIndex!,
        sourceSatoshis,
        transactionVersion: tx.version,
        otherInputs,
        inputIndex,
        outputs: tx.outputs,
        inputSequence: input.sequence!,
        subscript: lockingScript,
        lockTime: tx.lockTime,
        scope: signatureScope,
      });

      const rawSig = privateKey.sign(Hash.sha256(preimage));
      const sig = new TransactionSignature(rawSig.r, rawSig.s, signatureScope);
      const sigBytes = sig.toChecksigFormat();
      const pubkeyBytes = privateKey.toPublicKey().encode(true) as number[];
      const payloadArr = Array.from(fullPayload);

      const payloadChunk = payloadArr.length <= 75
        ? { op: payloadArr.length, data: payloadArr }
        : { op: 0x4c, data: payloadArr };

      return new UnlockingScript([
        { op: sigBytes.length, data: sigBytes },
        { op: pubkeyBytes.length, data: pubkeyBytes },
        payloadChunk,
      ]);
    },
    estimateLength: async () => estimateChronicleUnlockSize(fullPayload.length),
  };
}

function estimateChronicleChangeOutputSize(chronicleLockScriptLen: number): number {
  return 8 + varintSize(chronicleLockScriptLen) + chronicleLockScriptLen;
}

async function buildOpReturnTx(params: {
  utxo: UTXORecord;
  privateKey: PrivateKey;
  scriptBytes: number[];
  chronicle?: ChronicleConfig;
}): Promise<BuildResult> {
  const { utxo, privateKey, scriptBytes, chronicle } = params;
  const inputSats = Number(utxo.satoshis);
  const pkh = derivePubKeyHash(privateKey);
  const inputLockScript = Script.fromHex(utxo.locking_script);

  let changeLockScript: Script;
  let changeOutputSize: number;

  if (chronicle) {
    const chronicleLockBytes = buildChronicleP2PKH(pkh, chronicle.icao);
    changeLockScript = Script.fromBinary(chronicleLockBytes);
    changeOutputSize = estimateChronicleChangeOutputSize(chronicleLockBytes.length);
  } else {
    changeLockScript = new P2PKH().lock(pkh);
    changeOutputSize = P2PKH_OUTPUT_SIZE;
  }

  const inputUnlockSize = utxo.is_chronicle
    ? estimateChronicleUnlockSize(chronicle?.fullPayload?.length ?? 200)
    : P2PKH_UNLOCK_SIZE;
  const inputSize = INPUT_OVERHEAD + inputUnlockSize;
  const opReturnOutputSize = 8 + varintSize(scriptBytes.length) + scriptBytes.length;
  const estSize = TX_OVERHEAD + varintSize(1) + inputSize + opReturnOutputSize + changeOutputSize;
  const fee = calculateFee(estSize);
  const changeSats = inputSats - fee;

  if (changeSats < 1) {
    throw new Error(
      `Insufficient UTXO balance: ${inputSats} sats, fee ${fee} sats`,
    );
  }

  const tx = new Transaction();
  tx.version = chronicle ? CHRONICLE_TX_VERSION : 1;

  const unlockTemplate = (utxo.is_chronicle && chronicle)
    ? createChronicleUnlockTemplate(privateKey, chronicle.fullPayload, inputSats, inputLockScript)
    : new P2PKH().unlock(privateKey, "all", false, inputSats, inputLockScript);

  tx.addInput({
    sourceTXID: utxo.txid,
    sourceOutputIndex: utxo.vout,
    sourceSatoshis: inputSats,
    lockingScript: inputLockScript,
    unlockingScriptTemplate: unlockTemplate,
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
      isChronicle: !!chronicle,
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
  const fullPayload = buildOpReturnPayload(
    params.telemetry.icao,
    params.telemetry.ts,
    params.recordType as 0x01 | 0x02 | 0x03,
    payloadBytes,
  );
  return buildOpReturnTx({
    utxo: params.utxo,
    privateKey: params.privateKey,
    scriptBytes,
    chronicle: {
      icao: params.telemetry.icao,
      fullPayload,
    },
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

export async function buildRefillTx(params: {
  fundingUtxo: { txid: string; vout: number; satoshis: number; lockingScript: string };
  fundingKey: PrivateKey;
  recipientPkh: number[];
  amountSats: number;
}): Promise<{ tx: Transaction; recipientVout: number; changeVout: number | null }> {
  const { fundingUtxo, fundingKey, recipientPkh, amountSats } = params;
  const inputSats = fundingUtxo.satoshis;

  const hasChange = inputSats > amountSats + 200;
  const outputCount = hasChange ? 2 : 1;
  const estSize =
    TX_OVERHEAD +
    1 +
    (INPUT_OVERHEAD + P2PKH_UNLOCK_SIZE) +
    P2PKH_OUTPUT_SIZE * outputCount;
  const fee = calculateFee(estSize);

  const changeSats = inputSats - amountSats - fee;
  if (changeSats < 0) {
    throw new Error(
      `Funding UTXO insufficient: ${inputSats} sats for ${amountSats} + ${fee} fee`,
    );
  }

  const fundingPkh = derivePubKeyHash(fundingKey);
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

  tx.addOutput({
    lockingScript: new P2PKH().lock(recipientPkh),
    satoshis: amountSats,
  });

  const DUST_LIMIT = 546;
  let changeVout: number | null = null;
  if (changeSats >= DUST_LIMIT) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(fundingPkh),
      satoshis: changeSats,
    });
    changeVout = 1;
  }

  await tx.sign();

  return { tx, recipientVout: 0, changeVout };
}
