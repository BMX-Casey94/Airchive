import { HD, Mnemonic, PrivateKey, PublicKey, P2PKH } from '@bsv/sdk';

export { PublicKey, P2PKH };

export interface WalletVaultOptions {
  masterSeed: string;
}

const BIP44_BSV_EXTERNAL = "m/44'/236'/0'/0";

function createRootHD(mnemonicPhrase: string): HD {
  const phrase = mnemonicPhrase.trim().replace(/\s+/g, ' ');
  const hdWithOptionalMnemonic = HD as typeof HD & {
    fromMnemonic?: (m: string) => HD;
  };
  if (typeof hdWithOptionalMnemonic.fromMnemonic === 'function') {
    return hdWithOptionalMnemonic.fromMnemonic(phrase);
  }
  try {
    const seed = Mnemonic.fromString(phrase).toSeed();
    return HD.fromSeed(seed);
  } catch {
    throw new Error('Invalid BIP39 mnemonic phrase');
  }
}

function normaliseIcaoHex(icao: string): string {
  const trimmed = icao.trim();
  const withoutPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  const upper = withoutPrefix.toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(upper)) {
    throw new Error('ICAO address must be exactly six hexadecimal characters');
  }
  return upper;
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function applyRegistration(
  icaoToIndex: Map<string, number>,
  indexToIcao: Map<number, string>,
  icao: string,
  index: number,
): void {
  assertNonNegativeInt('index', index);
  const key = normaliseIcaoHex(icao);
  const existingIndex = icaoToIndex.get(key);
  if (existingIndex !== undefined && existingIndex !== index) {
    throw new Error(`ICAO ${key} is already registered to wallet index ${existingIndex}`);
  }
  const existingIcao = indexToIcao.get(index);
  if (existingIcao !== undefined && existingIcao !== key) {
    throw new Error(`Wallet index ${index} is already assigned to ICAO ${existingIcao}`);
  }
  icaoToIndex.set(key, index);
  indexToIcao.set(index, key);
}

/** BIP39 root, BIP44 `m/44'/236'/0'/0/{n}`; mappings live in memory only. */
export class WalletVault {
  private readonly externalChain: HD;

  private readonly icaoToIndex = new Map<string, number>();

  private readonly indexToIcao = new Map<number, string>();

  constructor(options: WalletVaultOptions) {
    const root = createRootHD(options.masterSeed);
    this.externalChain = root.derive(BIP44_BSV_EXTERNAL);
  }

  deriveAircraftKey(aircraftIndex: number): PrivateKey {
    assertNonNegativeInt('aircraftIndex', aircraftIndex);
    return this.externalChain.deriveChild(aircraftIndex).privKey;
  }

  getAircraftPrivateKey(icao: string): PrivateKey {
    const key = normaliseIcaoHex(icao);
    const index = this.icaoToIndex.get(key);
    if (index === undefined) {
      throw new Error(`No wallet index registered for ICAO ${key}`);
    }
    return this.deriveAircraftKey(index);
  }

  getAircraftAddress(icao: string): string {
    return this.getAircraftPrivateKey(icao).toAddress();
  }

  registerAircraft(icao: string, index: number): void {
    applyRegistration(this.icaoToIndex, this.indexToIcao, icao, index);
  }

  registerFleet(aircraft: Array<{ icao: string; wallet_index: number }>): void {
    const nextIcao = new Map(this.icaoToIndex);
    const nextIndex = new Map(this.indexToIcao);
    for (const entry of aircraft) {
      applyRegistration(nextIcao, nextIndex, entry.icao, entry.wallet_index);
    }
    this.icaoToIndex.clear();
    this.indexToIcao.clear();
    for (const [k, v] of nextIcao) this.icaoToIndex.set(k, v);
    for (const [k, v] of nextIndex) this.indexToIcao.set(k, v);
  }

  getFundingAddress(): string {
    return this.deriveAircraftKey(0).toAddress();
  }
}
