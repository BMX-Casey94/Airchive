import { describe, expect, it } from "vitest";

import {
  serialiseHeader,
  targetFromBits,
  verifyProofOfWork,
  type BlockHeader,
} from "../header-store.js";
import { computeTscRoot } from "../confirmation-poller.js";

// Mainnet block 800000, as returned by a header API. Real chain values are used
// deliberately: the point of these checks is that the maths agrees with the
// actual network, not with our own encoder.
const BLOCK_800000: BlockHeader = {
  height: 800_000,
  hash: "000000000000000000ad9056924410005d91b57f100bce345944e5caf56e8565",
  prev_hash: "00000000000000000b6ae23bbe9f549844c20943d8c20b8ceedbae8aa1dde8e0",
  merkle_root: "244993b9d8d961f5b4c91afa569adf9b6d8cd18e0bb6f769f5e62cdf2cc1468d",
  time: 1_688_957_834,
  bits: 0x180d_589d,
  nonce: 742_652_432,
  version: 770_793_472,
};

// The coinbase of that block, with its TSC branch to the same merkle root.
const COINBASE_TXID = "59360be3cc1db12b89a42a8d07df68043704684108a52a2fe603fbf93484b625";
const COINBASE_BRANCH = [
  "863d244a19150e0194da1290296e579c98a51e40c26dad24fc79b6fe5ef3e184",
  "e20c7a24846b681498da35c9265c0a1f9d4f624f5978b9715b0c143c96c3b64e",
  "46b8694ea781d0eeedbf8101ddff37e95b0aa5c016581af5ca47a03c12232359",
  "a837732ee1f402f9c862c61518e7db3051bee19bb0e2e6a6dbdba63d1ef569c2",
  "e677c9637cc4ac51a045105aa5ec3dcdac2af36a69c4abe472151c903ae9f725",
  "14130d8c8ec43db0d25ebaf7e55ef634050b4f5e32fb10e0eb091c4b2738d48a",
  "b84cfd34e0786bc8741953f3880a6f373300f5d1f0b8b809327582df7e0b8e1e",
  "0da2b75e2908256e0c96909e8c2b178a38ab55fb1101329e1491f613956e8cf0",
  "056118b6efb02122c06eb4f082660025ccdd5c3094b0ba487adf4eeb283a27ec",
  "69629fe7a5c668300fc879af4af25518855ff508893b49a995458e8bdc98b19a",
  "1e21a0da6a5c5d7c6281ef44a2128ff18db87ddd4346080f04be1d00272acf8d",
  "ea6115da490642910b06bf74be687711b44a4b20b67dd63590eac7fd5e827ce1",
  "a449547a801faccb1907f1ee6defb626969f236dc14426357ea31700b830df2e",
  "7e7d298ce14a490c4fecb02b08ad4b2abdedee6d3dbe01d666a33c2b7ba65530",
  "66e588212feb302a79c3e4ba28d172b06d9cbcdb8ca628ae355b0bdac2e1cafd",
  "a35a54cf7718ccd7b7f35b6b8a6f99914ccf7edac57e00005555d53c5ef1b223",
  "28205f82d4b490963788a5402c8e64ab1635f472e809ee6fee9f636d659181ae",
  "c8a131f1b30df758294d50c48614d1b16f4c6fd052dd3dabfc1e313970070774",
  "75ed4cfe29ffd9538d02de79dcbf3382c2ae1330c6ba18081be82fd365b0fb6c",
  "aae3110cd77305c5973dcd664004a955b8ec67f7343a0cf02e780c6ce8e6128f",
];

describe("block header verification", () => {
  it("serialises a header to exactly 80 bytes", () => {
    expect(serialiseHeader(BLOCK_800000)).toHaveLength(80);
  });

  it("accepts a real mainnet header", () => {
    expect(verifyProofOfWork(BLOCK_800000)).toBe(true);
  });

  it("rejects a header whose merkle root has been altered", () => {
    const tampered: BlockHeader = {
      ...BLOCK_800000,
      merkle_root: `${"0".repeat(63)}1`,
    };
    expect(verifyProofOfWork(tampered)).toBe(false);
  });

  it("rejects a header whose claimed hash does not match its contents", () => {
    const tampered: BlockHeader = { ...BLOCK_800000, nonce: BLOCK_800000.nonce + 1 };
    expect(verifyProofOfWork(tampered)).toBe(false);
  });

  it("rejects a header whose hash does not clear its difficulty target", () => {
    // A hash that matches its own contents but at trivial difficulty must still
    // fail, otherwise a forger could mine headers at no cost.
    const easy: BlockHeader = { ...BLOCK_800000, bits: 0x0300_0001 };
    expect(verifyProofOfWork(easy)).toBe(false);
  });

  it("expands compact bits to the expected target", () => {
    expect(targetFromBits(0x1d00_ffff)).toBe(
      0x0000_0000_ffffn * 2n ** BigInt(8 * (0x1d - 3)),
    );
    expect(targetFromBits(0x0100_0002)).toBe(0x02n >> 16n);
  });
});

describe("TSC merkle branch", () => {
  it("recomputes the block merkle root from a real branch", () => {
    expect(computeTscRoot(COINBASE_TXID, 0, COINBASE_BRANCH)).toBe(
      BLOCK_800000.merkle_root,
    );
  });

  it("does not reach the root from a branch with a substituted node", () => {
    const tampered = [...COINBASE_BRANCH];
    tampered[3] = `${"0".repeat(63)}1`;
    expect(computeTscRoot(COINBASE_TXID, 0, tampered)).not.toBe(
      BLOCK_800000.merkle_root,
    );
  });

  it("does not reach the root from the wrong index", () => {
    expect(computeTscRoot(COINBASE_TXID, 1, COINBASE_BRANCH)).not.toBe(
      BLOCK_800000.merkle_root,
    );
  });

  it("rejects a malformed branch", () => {
    expect(computeTscRoot(COINBASE_TXID, 0, ["abcd"])).toBeNull();
    expect(computeTscRoot(COINBASE_TXID, -1, COINBASE_BRANCH)).toBeNull();
  });
});
