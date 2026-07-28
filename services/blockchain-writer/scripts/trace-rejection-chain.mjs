/**
 * Walks a rejected transaction back through its ancestors until it finds the
 * first one the network refused for a reason of its own.
 *
 * A rejection cascades: once a parent is refused, every child that spends its
 * change is refused too, and the child's error says nothing useful. Only the
 * root of the chain carries the real fault.
 *
 * Usage: node scripts/trace-rejection-chain.mjs <txid> [arcadeUrl]
 */

const [, , startTxid, arcadeArg] = process.argv;
const ARCADE = (arcadeArg ?? "https://arcade-v2-us-1.bsvblockchain.tech").replace(/\/+$/, "");
const MAX_DEPTH = Number(process.env.MAX_DEPTH ?? 40);
const QUIET = process.env.QUIET === "1";

if (!startTxid) {
  console.error("Usage: node scripts/trace-rejection-chain.mjs <txid> [arcadeUrl]");
  process.exit(1);
}

/** Extended Format: version(4) + marker(6) + input count(1) then the outpoint. */
function firstParentTxid(rawTxHex) {
  if (!rawTxHex || rawTxHex.length < 150) return null;
  const isEf = rawTxHex.slice(8, 20).toLowerCase() === "0000000000ef";
  const outpointStart = isEf ? 22 : 10;
  const le = rawTxHex.slice(outpointStart, outpointStart + 64);
  if (le.length < 64) return null;
  return (le.match(/../g) ?? []).reverse().join("");
}

async function status(txid) {
  const res = await fetch(`${ARCADE}/tx/${txid}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Arcade ${res.status} for ${txid}`);
  return res.json();
}

let txid = startTxid;
for (let depth = 0; depth < MAX_DEPTH; depth++) {
  const info = await status(txid);
  if (info === null) {
    console.log(`${depth}: ${txid} — unknown to Arcade (never submitted, or pruned)`);
    break;
  }

  const size = info.rawTx ? info.rawTx.length / 2 : 0;
  const terminal = info.txStatus === "REJECTED" || info.txStatus === "DOUBLE_SPEND_ATTEMPTED";

  if (!QUIET || !terminal) {
    console.log(`${depth}: ${txid} ${info.txStatus} (${size} bytes)`);
    console.log(`   ${info.extraInfo ?? "(no extraInfo)"}`);
  }

  if (!terminal) {
    console.log(`\nRoot reached at depth ${depth}: this ancestor was accepted, so `
      + "the rejection starts at its child.");
    break;
  }

  const parent = firstParentTxid(info.rawTx);
  if (!parent) {
    console.log("\nNo parent could be read from the raw transaction.");
    break;
  }
  txid = parent;
}
