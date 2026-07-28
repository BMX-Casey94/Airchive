/**
 * Determines whether a rejected transaction's input had already been spent by
 * a different transaction — the one cause a node reports as a generic
 * validation failure rather than naming it.
 *
 * Usage: node scripts/find-conflicting-spend.mjs <rejectedTxid>
 */

import { P2PKH, Transaction, Utils } from "@bsv/sdk";

const [, , rejectedTxid] = process.argv;
const ARCADE = "https://arcade-v2-us-1.bsvblockchain.tech";
const WOC = "https://api.whatsonchain.com/v1/bsv/main";

if (!rejectedTxid) {
  console.error("Usage: node scripts/find-conflicting-spend.mjs <rejectedTxid>");
  process.exit(1);
}

function parse(hex) {
  const isEf = hex.slice(8, 20).toLowerCase() === "0000000000ef";
  return isEf ? Transaction.fromHexEF(hex) : Transaction.fromHex(hex);
}

async function json(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const rejected = await json(`${ARCADE}/tx/${rejectedTxid}`);
const tx = parse(rejected.rawTx);
const input = tx.inputs[0];
const parentId = input.sourceTXID ?? input.sourceTransaction?.id("hex");
const parentVout = input.sourceOutputIndex;
const prevOut = input.sourceTransaction?.outputs?.[parentVout];

console.log(`${rejectedTxid} (${rejected.txStatus}) spends ${parentId}:${parentVout}`);

// Recover the address from the previous output so the chain can be asked what
// actually happened to it.
const pkh = new P2PKH().parseLockingScript
  ? null
  : null;
const asmParts = prevOut.lockingScript.toASM().split(" ");
const hash160 = asmParts[2];
const address = Utils.toBase58Check(Utils.toArray(hash160, "hex"), [0]);
console.log(`previous output belongs to ${address} (${prevOut.satoshis} sats)`);

const unspent = await json(`${WOC}/address/${address}/unspent`);
const stillUnspent = unspent.some(
  (u) => u.tx_hash === parentId && u.tx_pos === parentVout,
);

console.log(`address holds ${unspent.length} unspent outputs on chain`);
console.log(
  stillUnspent
    ? "The input is STILL UNSPENT on chain, so the rejection was not a conflict."
    : "The input is ALREADY SPENT on chain — the rejection was a conflicting spend.",
);

if (!stillUnspent) {
  const history = await json(`${WOC}/address/${address}/history`);
  console.log(`scanning ${history.length} historical transactions for the spender…`);
  for (const entry of history.slice(-60)) {
    try {
      const raw = await json(`${WOC}/tx/${entry.tx_hash}/hex`).catch(async () => {
        const res = await fetch(`${WOC}/tx/${entry.tx_hash}/hex`);
        return res.text();
      });
      const hex = typeof raw === "string" ? raw : raw.hex;
      const candidate = Transaction.fromHex(hex);
      const match = candidate.inputs.some(
        (i) => (i.sourceTXID ?? "").toLowerCase() === parentId.toLowerCase()
          && i.sourceOutputIndex === parentVout,
      );
      if (match) {
        console.log(`spent by ${entry.tx_hash} (height ${entry.height})`);
        break;
      }
    } catch {
      // Ignore individual lookup failures; the scan is best-effort.
    }
  }
}
