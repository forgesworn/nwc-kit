export const NWC_INFO_KIND = 13194
export const NWC_REQUEST_KIND = 23194
export const NWC_RESPONSE_KIND = 23195

export type NwcCoreMethod =
  | 'pay_invoice'
  | 'make_invoice'
  | 'lookup_invoice'
  | 'get_balance'
  | 'get_info'

export type NwcErrorCode =
  | 'INVALID_CONNECTION'
  | 'CLIENT_CLOSED'
  | 'INFO_UNAVAILABLE'
  | 'UNSUPPORTED_ENCRYPTION'
  | 'UNSUPPORTED_METHOD'
  | 'UNSUPPORTED_EXTENSION'
  | 'INVALID_REQUEST'
  | 'PUBLISH_FAILED'
  | 'RESPONSE_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'INVALID_RESPONSE'
  | 'WALLET_ERROR'

export interface NwcEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface NwcFilter {
  ids?: string[]
  kinds?: number[]
  authors?: string[]
  limit?: number
  [key: `#${string}`]: string[] | undefined
}

export interface NwcSubscription {
  close(reason?: string): void
}

export interface NwcPublishResult {
  relay: string
  accepted: boolean
}

export interface NwcTransport {
  query(
    relays: readonly string[],
    filter: NwcFilter,
    timeoutMs: number,
  ): Promise<NwcEvent[]>

  subscribe(
    relays: readonly string[],
    filter: NwcFilter,
    handlers: {
      onevent(event: NwcEvent): void
      onclose?(): void
    },
    signal?: AbortSignal,
  ): NwcSubscription

  publish(
    relays: readonly string[],
    event: NwcEvent,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<NwcPublishResult[]>

  close(relays: readonly string[]): void
}

export interface NwcConnectionInfo {
  walletPubkey: string
  relays: readonly string[]
  lud16?: string
}

export interface NwcCapabilities {
  methods: readonly string[]
  encryptions: readonly string[]
  extensions: readonly string[]
  eventId: string
  createdAt: number
}

export interface NwcClientOptions {
  transport?: NwcTransport
  requestTimeoutMs?: number
  infoTimeoutMs?: number
  now?: () => number
}

export interface NwcRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface PayInvoiceParams {
  invoice: string
  /** Optional override for an amountless invoice, in milli-satoshis. */
  amount?: number
  metadata?: Record<string, unknown>
}

export interface PayInvoiceResult {
  preimage: string
  /** Routing fees in milli-satoshis. */
  fees_paid?: number
}

export interface MakeInvoiceParams {
  /** Invoice amount in milli-satoshis. */
  amount: number
  description?: string
  description_hash?: string
  expiry?: number
  metadata?: Record<string, unknown>
}

export interface NwcTransaction {
  type?: 'incoming' | 'outgoing'
  state?: 'pending' | 'settled' | 'accepted' | 'expired' | 'failed'
  invoice?: string
  description?: string
  description_hash?: string
  preimage?: string
  payment_hash?: string
  /** Transaction amount in milli-satoshis. */
  amount?: number
  /** Routing fees in milli-satoshis. */
  fees_paid?: number
  created_at?: number
  expires_at?: number
  settled_at?: number
  metadata?: Record<string, unknown>
}

export interface LookupInvoiceParams {
  payment_hash?: string
  invoice?: string
}

export interface GetBalanceResult {
  /** Wallet balance in milli-satoshis. */
  balance: number
}

export interface GetInfoResult {
  alias?: string
  color?: string
  pubkey?: string
  network?: string
  block_height?: number
  block_hash?: string
  methods: string[]
  extensions?: string[]
}
