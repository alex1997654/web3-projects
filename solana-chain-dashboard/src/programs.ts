export type FieldKind = 'u64' | 'i64' | 'bool' | 'pubkey' | 'string'

export interface FieldDef {
  readonly name: string
  readonly kind: FieldKind
}

export interface LayoutDef {
  readonly name: string
  readonly discriminator: string
  readonly fields: readonly FieldDef[]
  /**
   * exact: the fields must consume the whole payload (historical program
   * builds, fully mapped). prefix: the fields are a verified head of the
   * event and the remainder is reported as an unmapped tail instead of
   * failing the decode. Used while the current on-chain build carries
   * more fields than are mapped here.
   */
  readonly mode?: 'exact' | 'prefix'
}

/**
 * Maps decoded event fields of a trade-style event onto the columns the
 * session stats aggregate. Programs without a trade event have null here
 * and the dashboard renders their feed without volume accounting.
 */
export interface TradeMap {
  readonly walletField: string
  readonly solLamportsField: string
  readonly tokenAmountField: string
  readonly isBuyField: string
  readonly mintField: string
}

export interface ProgramDef {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly layouts: readonly LayoutDef[]
  readonly tradeMap: TradeMap | null
  readonly showInstructions: boolean
}

export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

const tradeFieldsV2: readonly FieldDef[] = [
  { name: 'mint', kind: 'pubkey' },
  { name: 'solAmount', kind: 'u64' },
  { name: 'tokenAmount', kind: 'u64' },
  { name: 'isBuy', kind: 'bool' },
  { name: 'user', kind: 'pubkey' },
  { name: 'timestamp', kind: 'i64' },
  { name: 'virtualSolReserves', kind: 'u64' },
  { name: 'virtualTokenReserves', kind: 'u64' },
]

// Current on-chain build (verified against live mainnet captures, see
// scripts/verify-live.ts). The head through the reserve quads and the fee
// recipient pubkey is stable; the program now appends extra fields we do
// not fully map, so this layout is a prefix and the tail is reported.
const tradeFieldsV3: readonly FieldDef[] = [
  ...tradeFieldsV2,
  { name: 'realSolReserves', kind: 'u64' },
  { name: 'realTokenReserves', kind: 'u64' },
  { name: 'feeRecipient', kind: 'pubkey' },
]

// Pre-2024-08 build of the program: no reserve fields on TradeEvent.
const tradeFieldsV1: readonly FieldDef[] = tradeFieldsV2.slice(0, 6)

const createFieldsV2: readonly FieldDef[] = [
  { name: 'name', kind: 'string' },
  { name: 'symbol', kind: 'string' },
  { name: 'uri', kind: 'string' },
  { name: 'mint', kind: 'pubkey' },
  { name: 'bondingCurve', kind: 'pubkey' },
  { name: 'user', kind: 'pubkey' },
  { name: 'creator', kind: 'pubkey' },
  { name: 'timestamp', kind: 'i64' },
  { name: 'virtualTokenReserves', kind: 'u64' },
  { name: 'virtualSolReserves', kind: 'u64' },
  { name: 'realTokenReserves', kind: 'u64' },
]

// Current build: strings and the four pubkeys are stable up front, the
// rest grew beyond this mapping. Prefix only.
const createFieldsV3: readonly FieldDef[] = createFieldsV2.slice(0, 7)

// Pre-2024-10 build: no separate creator, timestamp, or reserve fields.
const createFieldsV1: readonly FieldDef[] = createFieldsV2.slice(0, 6)

const completeFieldsV2: readonly FieldDef[] = [
  { name: 'mint', kind: 'pubkey' },
  { name: 'bondingCurve', kind: 'pubkey' },
  { name: 'user', kind: 'pubkey' },
  { name: 'timestamp', kind: 'i64' },
]

const completeFieldsV1: readonly FieldDef[] = completeFieldsV2.slice(0, 3)

const pumpFunLayouts: readonly LayoutDef[] = [
  { name: 'TradeEvent', discriminator: 'bddb7fd34ee661ee', fields: tradeFieldsV2 },
  { name: 'TradeEvent', discriminator: 'bddb7fd34ee661ee', fields: tradeFieldsV1 },
  { name: 'TradeEvent', discriminator: 'bddb7fd34ee661ee', fields: tradeFieldsV3, mode: 'prefix' },
  { name: 'CreateEvent', discriminator: '1b72a94ddeeb6376', fields: createFieldsV2 },
  { name: 'CreateEvent', discriminator: '1b72a94ddeeb6376', fields: createFieldsV1 },
  { name: 'CreateEvent', discriminator: '1b72a94ddeeb6376', fields: createFieldsV3, mode: 'prefix' },
  { name: 'CompleteEvent', discriminator: '5f72619cd42e9808', fields: completeFieldsV2 },
  { name: 'CompleteEvent', discriminator: '5f72619cd42e9808', fields: completeFieldsV1 },
  { name: 'CompleteEvent', discriminator: '5f72619cd42e9808', fields: completeFieldsV1, mode: 'prefix' },
]

export const PUMP_FUN: ProgramDef = {
  id: PUMP_FUN_PROGRAM_ID,
  label: 'pump.fun bonding curve',
  note: 'Constant stream of token creates, buys, and sells on mainnet. Trade events carry SOL amounts, so session volume and wallet rankings are real numbers.',
  layouts: pumpFunLayouts,
  tradeMap: {
    walletField: 'user',
    solLamportsField: 'solAmount',
    tokenAmountField: 'tokenAmount',
    isBuyField: 'isBuy',
    mintField: 'mint',
  },
  showInstructions: false,
}

export const MEMO: ProgramDef = {
  id: MEMO_PROGRAM_ID,
  label: 'memo program',
  note: 'The memo program prints its payload as a plain Program log line. No binary decoding needed, which makes it a good control for the log parser.',
  layouts: [],
  tradeMap: null,
  showInstructions: false,
}

export const JUPITER: ProgramDef = {
  id: JUPITER_PROGRAM_ID,
  label: 'jupiter aggregator',
  note: 'Watched at instruction level: the router logs which entrypoint each swap took. Binary event layouts are not registered for it, so data lines render raw.',
  layouts: [],
  tradeMap: null,
  showInstructions: true,
}

export interface ClusterDef {
  readonly id: string
  readonly label: string
  readonly wsDefault: string
  readonly stallTimeoutMs: number
  readonly programs: readonly ProgramDef[]
}

export const MAINNET_BETA: ClusterDef = {
  id: 'mainnet-beta',
  label: 'mainnet-beta',
  wsDefault: 'wss://api.mainnet-beta.solana.com',
  stallTimeoutMs: 45_000,
  programs: [PUMP_FUN, MEMO, JUPITER],
}

export const DEVNET: ClusterDef = {
  id: 'devnet',
  label: 'devnet',
  wsDefault: 'wss://api.devnet.solana.com',
  // Devnet can be quiet for minutes at a time; silence is not an outage.
  stallTimeoutMs: 0,
  programs: [MEMO],
}

export const CLUSTERS: readonly ClusterDef[] = [MAINNET_BETA, DEVNET]

export function programById(id: string): ProgramDef | null {
  for (const c of CLUSTERS) {
    for (const p of c.programs) {
      if (p.id === id) return p
    }
  }
  return null
}
