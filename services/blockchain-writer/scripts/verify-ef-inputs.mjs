/**
 * Checks that the previous-output value and locking script a transaction
 * declares in Extended Format match what the parent transaction actually
 * created on chain.
 *
 * These values are part of the BSV sighash preimage, so a mismatch produces a
 * signature that cannot verify and the node rejects the transaction with a
 * generic validation failure. Because the writer records its own change
 * locally, a mismatch here means the local pool disagrees with the chain.
 *
 * Usage: node scripts/verify-ef-inputs.mjs <txid> [arcadeUrl]
 */

import { Transaction } from "@bsv/sdk";

const [, , txid, arcadeArg] = process.argv;
const ARCADE = (arcadeArg ?? "https://arcade-v2-us-1.bsvblockchain.tech").replace(/\/+$/, "");

if (!txid) {
  console.error("Usage: node scripts/verify-ef-inputs.mjs <txid> [arcadeUrl]");
  process.exit(1);
}

async function rawTx(id) {
  const res = await fetch(`${ARCADE}/tx/${id}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Arcade ${res.status} for ${id}`);
  const body = await res.json();
  return { hex: body.rawTx, status: body.txStatus };
}

/** Arcade echoes back whatever was submitted, which for this writer is EF. */
function parse(hex) {
  const isEf = hex.slice(8, 20).toLowerCase() === "0000000000ef";
  return isEf ? Transaction.fromHexEF(hex) : Transaction.fromHex(hex);
}

const child = await rawTx(txid);
const tx = parse(child.hex);
console.log(`${txid} (${child.status}) version=${tx.version} inputs=${tx.inputs.length} outputs=${tx.outputs.length}`);

let declaredIn = 0;
for (const [i, input] of tx.inputs.entries()) {
  const parentId = input.sourceTXID ?? input.sourceTransaction?.id("hex");
  const declaredSats = input.sourceTransaction?.outputs?.[input.sourceOutputIndex]?.satoshis;
  const declaredScript = input.sourceTransaction?.outputs?.[input.sourceOutputIndex]
    ?.lockingScript?.toHex();

  const parent = await rawTx(parentId);
  const parentTx = parse(parent.hex);
  const actual = parentTx.outputs[input.sourceOutputIndex];

  const satsMatch = declaredSats === actual?.satoshis;
  const scriptMatch = declaredScript === actual?.lockingScript?.toHex();
  declaredIn += declaredSats ?? 0;

  console.log(
    `  input ${i}: parent ${parentId}:${input.sourceOutputIndex} (${parent.status})\n`
    + `    declared ${declaredSats} sats, actual ${actual?.satoshis} sats  -> ${satsMatch ? "match" : "MISMATCH"}\n`
    + `    locking script -> ${scriptMatch ? "match" : "MISMATCH"}`,
  );
}

const out = tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0);
const size = child.hex.length / 2;
console.log(`  inputs ${declaredIn} sats, outputs ${out} sats, fee ${declaredIn - out} sats `
  + `over ${size} bytes (${((declaredIn - out) / size).toFixed(3)} sat/byte)`);

// Unlocking scripts are evaluated against the declared previous outputs, which
// is exactly what a node does before it decides a transaction is invalid.
try {
  const scriptsValid = await tx.verify("scripts only");
  console.log(`  unlocking scripts: ${scriptsValid ? "valid" : "INVALID"}`);
} catch (err) {
  console.log(`  unlocking scripts: could not evaluate — ${err.message}`);
}

for (const [i, output] of tx.outputs.entries()) {
  const asm = output.lockingScript.toASM();
  console.log(`  output ${i}: ${output.satoshis} sats, ${output.lockingScript.toHex().length / 2} `
    + `bytes, starts ${asm.slice(0, 40)}`);
}
