import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import type {
  NwcEvent,
  NwcFilter,
  NwcPublishResult,
  NwcSubscription,
  NwcTransport,
} from '../src/index.js'

export const WALLET_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
export const WALLET_PUBKEY = getPublicKey(WALLET_SECRET)
export const CLIENT_SECRET_HEX = '11'.repeat(32)
export const CLIENT_SECRET = Uint8Array.from({ length: 32 }, () => 0x11)
export const CLIENT_PUBKEY = getPublicKey(CLIENT_SECRET)
export const VALID_URI = `nostr+walletconnect://${WALLET_PUBKEY}?relay=${encodeURIComponent('wss://relay.one')}&relay=${encodeURIComponent('wss://relay.two/path')}&secret=${CLIENT_SECRET_HEX}&lud16=alice%40example.com`

export type WalletResponseFactory = (
  request: NwcEvent,
  method: string,
  params: Record<string, unknown>,
) => {
  result?: unknown
  error?: { code: string; message: string } | null
  resultType?: string
  // Alby Hub marshals the response error as `json:"error,omitempty"` over a nil
  // pointer, so a successful response carries no error key at all.
  omitError?: boolean
}

export class FakeTransport implements NwcTransport {
  readonly requests: NwcEvent[] = []
  readonly queries: Array<{ relays: readonly string[]; filter: NwcFilter }> = []
  readonly subscriptions: NwcFilter[] = []
  closeCount = 0
  acceptPublish = true
  respond = true
  infoMethods = ['pay_invoice', 'make_invoice', 'lookup_invoice', 'get_balance', 'get_info', 'list_transactions']
  infoEncryptions = ['nip44_v2']
  infoExtensions = ['05']
  infoEvents?: NwcEvent[]
  responseFactory?: WalletResponseFactory
  beforeValidResponse?: (request: NwcEvent, deliver: (event: NwcEvent) => void) => void
  beforeSubscriptionReturn?: (filter: NwcFilter, deliver: (event: NwcEvent) => void) => void

  #handler: ((event: NwcEvent) => void) | undefined

  async query(relays: readonly string[], filter: NwcFilter): Promise<NwcEvent[]> {
    this.queries.push({ relays, filter })
    if (this.infoEvents) return this.infoEvents
    return [this.createInfoEvent()]
  }

  subscribe(
    _relays: readonly string[],
    filter: NwcFilter,
    handlers: { onevent(event: NwcEvent): void },
  ): NwcSubscription {
    this.subscriptions.push(filter)
    this.#handler = handlers.onevent
    this.beforeSubscriptionReturn?.(filter, handlers.onevent)
    return {
      close: () => {
        this.closeCount++
        this.#handler = undefined
      },
    }
  }

  async publish(relays: readonly string[], request: NwcEvent): Promise<NwcPublishResult[]> {
    this.requests.push(request)
    if (this.respond && this.#handler) {
      const conversationKey = nip44.v2.utils.getConversationKey(WALLET_SECRET, request.pubkey)
      const plaintext = nip44.v2.decrypt(request.content, conversationKey)
      const payload = JSON.parse(plaintext) as { method: string; params: Record<string, unknown> }
      const configured = this.responseFactory?.(request, payload.method, payload.params)
      const response = configured ?? this.defaultResponse(payload.method)
      const validEvent = this.createResponseEvent(request, {
        result_type: ('resultType' in response ? response.resultType : undefined) ?? payload.method,
        ...(response.omitError ? {} : { error: response.error ?? null }),
        result: response.result,
      })
      this.beforeValidResponse?.(request, (event) => this.#handler?.(event))
      queueMicrotask(() => this.#handler?.(validEvent))
    }
    return relays.map((relay) => ({ relay, accepted: this.acceptPublish }))
  }

  close(): void {
    this.closeCount++
    this.#handler = undefined
  }

  createInfoEvent(overrides: Partial<NwcEvent> = {}): NwcEvent {
    const event = finalizeEvent({
      kind: overrides.kind ?? 13194,
      created_at: overrides.created_at ?? 1_700_000_000,
      tags: overrides.tags ?? [
        ['encryption', this.infoEncryptions.join(' ')],
        ['extensions', this.infoExtensions.join(' ')],
      ],
      content: overrides.content ?? this.infoMethods.join(' '),
    }, WALLET_SECRET)
    return {
      ...event,
      ...(overrides.id !== undefined ? { id: overrides.id } : {}),
      ...(overrides.pubkey !== undefined ? { pubkey: overrides.pubkey } : {}),
      ...(overrides.sig !== undefined ? { sig: overrides.sig } : {}),
    }
  }

  createResponseEvent(request: NwcEvent, payload: Record<string, unknown>, tags?: string[][]): NwcEvent {
    const conversationKey = nip44.v2.utils.getConversationKey(WALLET_SECRET, request.pubkey)
    return finalizeEvent({
      kind: 23195,
      created_at: request.created_at + 1,
      tags: tags ?? [['p', request.pubkey], ['e', request.id]],
      content: nip44.v2.encrypt(JSON.stringify(payload), conversationKey),
    }, WALLET_SECRET)
  }

  private defaultResponse(method: string): ReturnType<WalletResponseFactory> {
    const results: Record<string, unknown> = {
      pay_invoice: { preimage: 'ab'.repeat(32), fees_paid: 12 },
      make_invoice: { invoice: 'lnbc1example', payment_hash: 'cd'.repeat(32), amount: 1_000 },
      lookup_invoice: { state: 'settled', payment_hash: 'cd'.repeat(32), preimage: 'ab'.repeat(32) },
      get_balance: { balance: 42_000 },
      get_info: { methods: this.infoMethods, extensions: this.infoExtensions, network: 'mainnet' },
      list_transactions: { transactions: [{ type: 'incoming', state: 'settled', payment_hash: 'cd'.repeat(32) }] },
    }
    return { result: results[method] ?? {}, error: null }
  }
}
