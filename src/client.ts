import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { parseNwcConnection } from './connection.js'
import { NwcError, safeMessage } from './error.js'
import { NostrRelayTransport } from './transport.js'
import {
  NWC_INFO_KIND,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  type GetBalanceResult,
  type GetInfoResult,
  type LookupInvoiceParams,
  type MakeInvoiceParams,
  type NwcCapabilities,
  type NwcClientOptions,
  type NwcCoreMethod,
  type NwcErrorCode,
  type NwcEvent,
  type NwcRequestOptions,
  type NwcTransaction,
  type NwcTransport,
  type PayInvoiceParams,
  type PayInvoiceResult,
} from './types.js'

const HEX_64 = /^[0-9a-f]{64}$/i
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_INFO_TIMEOUT_MS = 10_000
const MAX_RESPONSE_CONTENT_CHARS = 131_072
const MAX_INFO_CONTENT_CHARS = 8192
const MAX_CAPABILITY_ITEMS = 128
const MAX_CAPABILITY_ITEM_CHARS = 128
const MAX_INVOICE_CHARS = 20_000
const MAX_METADATA_CHARS = 4096
const MAX_TIMEOUT_MS = 300_000
const MAX_INFO_EVENTS = 32
const MAX_INFO_ATTEMPTS = 3
/** 2100-01-01. Beyond this a "Unix seconds" field is something else, usually milliseconds. */
const MAX_TIMESTAMP_SECONDS = 4_102_444_800
const MIN_INFO_ATTEMPT_MS = 1500
/** Treat a query that used this much of its budget as a timeout, not an answer. */
const SLOW_RELAY_FRACTION = 0.9
const MAX_EVENT_TAGS = 64
const MAX_TAG_ITEMS = 16
const MAX_TAG_ITEM_CHARS = 4096
const MAX_EVENT_TAG_CHARS = 65_536
const MAX_REQUEST_PLAINTEXT_CHARS = 32_768
const HEX_128 = /^[0-9a-f]{128}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True when a field carries no value, however the wallet chose to spell it.
 *
 * Go marshals an unset string as `""` and a nil pointer as `null` unless the
 * struct tag says `omitempty`, and NIP-47 wallet services written in Go are
 * common. Alby Hub sends `"preimage": ""` and `"settled_at": null` on every
 * unsettled invoice, so reading `""` as a malformed preimage rejects the most
 * ordinary response there is: an invoice that has just been created.
 *
 * This is about how emptiness is spelled, not about tolerating bad data. A
 * preimage that is present and not 32 bytes of hex is still refused, and
 * `pay_invoice` still demands a real one, because there the preimage is the
 * evidence of settlement rather than an optional detail.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function splitWords(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter(Boolean) ?? []
}

function singleTag(event: NwcEvent, name: string): string | undefined {
  const matches = event.tags.filter((tag) => tag[0] === name)
  if (matches.length > 1) {
    throw new NwcError('INVALID_RESPONSE', `NWC event contains duplicate ${name} tags`)
  }
  return matches[0]?.[1]
}

function positiveSafeInteger(
  value: unknown,
  field: string,
  allowZero = false,
  code: Extract<NwcErrorCode, 'INVALID_REQUEST' | 'INVALID_RESPONSE'> = 'INVALID_REQUEST',
): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    throw new NwcError(code, `${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`)
  }
  return value as number
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new NwcError('INVALID_REQUEST', `timeout must be between 100 and ${MAX_TIMEOUT_MS} milliseconds`)
  }
  return value
}

function optionalBoundedString(value: unknown, field: string, maximum = MAX_METADATA_CHARS): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum) {
    throw new NwcError('INVALID_RESPONSE', `${field} must be a bounded string`)
  }
  return value
}

function validateInvoice(invoice: unknown): string {
  if (typeof invoice !== 'string' || invoice.length === 0 || invoice.length > MAX_INVOICE_CHARS) {
    throw new NwcError('INVALID_REQUEST', 'invoice must be a non-empty bounded string')
  }
  return invoice
}

function validateMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined
  if (!isRecord(metadata)) throw new NwcError('INVALID_REQUEST', 'metadata must be an object')
  try {
    const serialised = JSON.stringify(metadata)
    if (serialised.length > MAX_METADATA_CHARS) {
      throw new NwcError('INVALID_REQUEST', `metadata must not exceed ${MAX_METADATA_CHARS} characters`)
    }
    const snapshot: unknown = JSON.parse(serialised)
    if (!isRecord(snapshot)) throw new Error('metadata did not serialise to an object')
    return snapshot
  } catch (error) {
    if (error instanceof NwcError) throw error
    throw new NwcError('INVALID_REQUEST', 'metadata must be JSON serialisable')
  }
}

function serialiseRequest(method: string, params: object): string {
  if (typeof method !== 'string' || method.length === 0 || method.length > MAX_CAPABILITY_ITEM_CHARS || !isRecord(params)) {
    throw new NwcError('INVALID_REQUEST', 'NWC method and params are invalid')
  }
  try {
    const serialised = JSON.stringify({ method, params })
    if (serialised.length > MAX_REQUEST_PLAINTEXT_CHARS) {
      throw new NwcError('INVALID_REQUEST', 'NWC request is too large')
    }
    const snapshot: unknown = JSON.parse(serialised)
    if (!isRecord(snapshot) || snapshot.method !== method || !isRecord(snapshot.params)) {
      throw new NwcError('INVALID_REQUEST', 'NWC request did not serialise safely')
    }
    return serialised
  } catch (error) {
    if (error instanceof NwcError) throw error
    throw new NwcError('INVALID_REQUEST', 'NWC request must be JSON serialisable')
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new NwcError('INVALID_RESPONSE', 'NWC response is not a JSON object')
  }
}

function isNwcEventShape(event: unknown): event is NwcEvent {
  if (
    !isRecord(event) ||
    typeof event.id !== 'string' || !HEX_64.test(event.id) ||
    typeof event.pubkey !== 'string' || !HEX_64.test(event.pubkey) ||
    !Number.isSafeInteger(event.created_at) || Number(event.created_at) < 0 ||
    !Number.isSafeInteger(event.kind) || Number(event.kind) < 0 ||
    typeof event.content !== 'string' ||
    typeof event.sig !== 'string' || !HEX_128.test(event.sig) ||
    !Array.isArray(event.tags) || event.tags.length > MAX_EVENT_TAGS
  ) return false

  let tagCharacters = 0
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_ITEMS) return false
    for (const value of tag) {
      if (typeof value !== 'string' || value.length > MAX_TAG_ITEM_CHARS) return false
      tagCharacters += value.length
      if (tagCharacters > MAX_EVENT_TAG_CHARS) return false
    }
  }
  return true
}

function verifyExternalEvent(event: unknown): event is NwcEvent {
  if (!isNwcEventShape(event)) return false
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    })
  } catch {
    return false
  }
}

function isWalletResponseForRequest(
  event: unknown,
  walletPubkey: string,
  requestId: string,
): event is NwcEvent {
  return isNwcEventShape(event) &&
    event.kind === NWC_RESPONSE_KIND &&
    event.pubkey === walletPubkey &&
    event.tags.some((tag) => tag[0] === 'e' && tag[1] === requestId) &&
    verifyExternalEvent(event)
}

function boundedStringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CAPABILITY_ITEMS ||
    !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_CAPABILITY_ITEM_CHARS)
  ) {
    throw new NwcError('INVALID_RESPONSE', `${field} must be a bounded string list`)
  }
  return [...new Set(value)]
}

function boundedWords(value: string | undefined, field: string): string[] {
  return boundedStringList(splitWords(value), field)
}

export class NwcClient {
  readonly walletPubkey: string
  readonly clientPubkey: string
  readonly relays: readonly string[]

  readonly #transport: NwcTransport
  readonly #requestTimeoutMs: number
  readonly #infoTimeoutMs: number
  readonly #now: () => number
  readonly #secretKey: Uint8Array
  readonly #conversationKey: Uint8Array
  readonly #pending = new Set<(error: NwcError) => void>()
  #capabilities: NwcCapabilities | undefined
  #closed = false

  constructor(connectionUri: string, options: NwcClientOptions = {}) {
    const requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    const infoTimeoutMs = validateTimeout(options.infoTimeoutMs ?? DEFAULT_INFO_TIMEOUT_MS)
    const transport = options.transport ?? new NostrRelayTransport()
    const parsed = parseNwcConnection(connectionUri)
    this.walletPubkey = parsed.walletPubkey
    this.clientPubkey = parsed.clientPubkey
    this.relays = Object.freeze([...parsed.relays])
    this.#secretKey = parsed.secretKey
    this.#conversationKey = parsed.conversationKey
    this.#transport = transport
    this.#requestTimeoutMs = requestTimeoutMs
    this.#infoTimeoutMs = infoTimeoutMs
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  async connect(): Promise<NwcCapabilities> {
    this.#assertOpen()
    const event = await this.#discoverInfoEvent()

    const encryptions = boundedWords(singleTag(event, 'encryption'), 'NWC encryptions')
    if (!encryptions.includes('nip44_v2')) {
      throw new NwcError('UNSUPPORTED_ENCRYPTION', 'The NWC wallet does not advertise NIP-44 v2')
    }

    const methods = boundedWords(event.content, 'NWC methods')
    if (methods.length === 0) {
      throw new NwcError('INVALID_RESPONSE', 'NWC wallet info event advertises no methods')
    }

    this.#capabilities = Object.freeze({
      methods: Object.freeze([...new Set(methods)]),
      encryptions: Object.freeze([...new Set(encryptions)]),
      extensions: Object.freeze(boundedWords(singleTag(event, 'extensions'), 'NWC extensions')),
      eventId: event.id,
      createdAt: event.created_at,
    })
    return this.#copyCapabilities(this.#capabilities)
  }

  /**
   * Capability discovery is a read, so repeating it cannot cost anything. That
   * is the opposite of a payment, and the distinction is why retrying here is
   * safe when retrying `execute` never is.
   *
   * It earns its place: against a single relay, a query for the info event
   * comes back empty often enough that one attempt makes `connect()`
   * unreliable, and it usually fails as a fast empty answer rather than as a
   * timeout. Only that fast case is retried. A relay that spent its whole
   * budget is unresponsive rather than empty, and asking it again buys nothing
   * while adding load to something already struggling.
   *
   * Retries run inside the existing `infoTimeoutMs` budget rather than
   * extending it, so the worst case a caller waits is unchanged.
   */
  async #discoverInfoEvent(): Promise<NwcEvent> {
    const deadline = Date.now() + this.#infoTimeoutMs
    let transportFailed = false

    for (let attempt = 0; attempt < MAX_INFO_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now()
      if (attempt > 0 && remaining <= MIN_INFO_ATTEMPT_MS) break

      // Each attempt gets the whole remaining budget rather than a fixed
      // slice. Slicing would cut off a relay that is merely slow, turning a
      // query that would have completed into a timeout: the opposite of the
      // problem being solved.
      const budget = attempt === 0 ? this.#infoTimeoutMs : remaining
      const started = Date.now()
      let events: unknown
      try {
        events = await this.#transport.query(
          this.relays,
          { kinds: [NWC_INFO_KIND], authors: [this.walletPubkey], limit: 5 },
          budget,
        )
      } catch {
        this.#assertOpen()
        transportFailed = true
        continue
      }
      this.#assertOpen()
      // A relay that consumed its whole budget is unresponsive, not merely
      // empty. Asking again buys nothing and adds load to something already
      // struggling, so only a quick empty answer is worth retrying.
      const spentWholeBudget = Date.now() - started >= budget * SLOW_RELAY_FRACTION

      // A relay flooding the response is a definitive rejection, not something
      // to retry into.
      if (!Array.isArray(events) || events.length > MAX_INFO_EVENTS) {
        throw new NwcError('INFO_UNAVAILABLE', 'NWC wallet capability discovery returned invalid events')
      }

      const event = events
        .filter((candidate) =>
          isNwcEventShape(candidate) &&
          candidate.kind === NWC_INFO_KIND &&
          candidate.pubkey === this.walletPubkey &&
          candidate.content.length <= MAX_INFO_CONTENT_CHARS &&
          verifyExternalEvent(candidate),
        )
        .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0]

      if (event) return event
      if (spentWholeBudget) break
    }

    throw new NwcError(
      'INFO_UNAVAILABLE',
      transportFailed
        ? 'NWC wallet capability discovery failed'
        : 'No signed NWC wallet info event was available',
    )
  }

  get capabilities(): NwcCapabilities | undefined {
    return this.#capabilities ? this.#copyCapabilities(this.#capabilities) : undefined
  }

  async payInvoice(params: PayInvoiceParams, options: NwcRequestOptions = {}): Promise<PayInvoiceResult> {
    const invoice = validateInvoice(params.invoice)
    if (params.amount !== undefined) positiveSafeInteger(params.amount, 'amount')
    const metadata = validateMetadata(params.metadata)
    const result = await this.execute('pay_invoice', {
      invoice,
      ...(params.amount !== undefined ? { amount: params.amount } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    }, options)
    if (!isRecord(result) || typeof result.preimage !== 'string' || !HEX_64.test(result.preimage)) {
      throw new NwcError('INVALID_RESPONSE', 'NWC pay_invoice response has no valid preimage')
    }
    if (result.fees_paid !== undefined) positiveSafeInteger(result.fees_paid, 'fees_paid', true, 'INVALID_RESPONSE')
    return {
      preimage: result.preimage.toLowerCase(),
      ...(result.fees_paid !== undefined ? { fees_paid: result.fees_paid as number } : {}),
    }
  }

  async makeInvoice(params: MakeInvoiceParams, options: NwcRequestOptions = {}): Promise<NwcTransaction> {
    positiveSafeInteger(params.amount, 'amount')
    if (params.description !== undefined && params.description_hash !== undefined) {
      throw new NwcError('INVALID_REQUEST', 'make_invoice accepts description or description_hash, not both')
    }
    if (params.expiry !== undefined) positiveSafeInteger(params.expiry, 'expiry')
    if (params.description !== undefined && (typeof params.description !== 'string' || params.description.length > MAX_METADATA_CHARS)) {
      throw new NwcError('INVALID_REQUEST', 'description must be a bounded string')
    }
    if (params.description_hash !== undefined && !HEX_64.test(params.description_hash)) {
      throw new NwcError('INVALID_REQUEST', 'description_hash must be 32-byte hex')
    }
    const metadata = validateMetadata(params.metadata)
    const request = {
      amount: params.amount,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.description_hash !== undefined ? { description_hash: params.description_hash } : {}),
      ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    }
    return this.validateTransaction(await this.execute('make_invoice', request, options), 'make_invoice')
  }

  async lookupInvoice(params: LookupInvoiceParams, options: NwcRequestOptions = {}): Promise<NwcTransaction> {
    if ((!params.payment_hash && !params.invoice) || (params.payment_hash !== undefined && params.invoice !== undefined)) {
      throw new NwcError('INVALID_REQUEST', 'lookup_invoice requires exactly one of payment_hash or invoice')
    }
    if (params.payment_hash !== undefined && !HEX_64.test(params.payment_hash)) {
      throw new NwcError('INVALID_REQUEST', 'payment_hash must be 32-byte hex')
    }
    if (params.invoice !== undefined) validateInvoice(params.invoice)
    const request = {
      ...(params.payment_hash !== undefined ? { payment_hash: params.payment_hash } : {}),
      ...(params.invoice !== undefined ? { invoice: params.invoice } : {}),
    }
    return this.validateTransaction(await this.execute('lookup_invoice', request, options), 'lookup_invoice')
  }

  async getBalance(options: NwcRequestOptions = {}): Promise<GetBalanceResult> {
    const result = await this.execute('get_balance', {}, options)
    if (!isRecord(result)) throw new NwcError('INVALID_RESPONSE', 'get_balance result is not an object')
    return { balance: positiveSafeInteger(result.balance, 'balance', true, 'INVALID_RESPONSE') }
  }

  async getInfo(options: NwcRequestOptions = {}): Promise<GetInfoResult> {
    const result = await this.execute('get_info', {}, options)
    if (!isRecord(result)) throw new NwcError('INVALID_RESPONSE', 'get_info result is not an object')
    const methods = boundedStringList(result.methods, 'get_info methods')
    // Every optional field here is a nil-able pointer in at least one shipping
    // wallet, so each arrives as null rather than absent when it has no value.
    const extensions = isAbsent(result.extensions)
      ? undefined
      : boundedStringList(result.extensions, 'get_info extensions')
    const alias = isAbsent(result.alias) ? undefined : optionalBoundedString(result.alias, 'alias')
    const color = isAbsent(result.color) ? undefined : optionalBoundedString(result.color, 'color', 64)
    const pubkey = isAbsent(result.pubkey) ? undefined : optionalBoundedString(result.pubkey, 'pubkey', 64)
    if (pubkey !== undefined && !HEX_64.test(pubkey)) {
      throw new NwcError('INVALID_RESPONSE', 'get_info pubkey must be 32-byte hex')
    }
    const network = isAbsent(result.network) ? undefined : optionalBoundedString(result.network, 'network', 64)
    const blockHash = isAbsent(result.block_hash) ? undefined : optionalBoundedString(result.block_hash, 'block_hash', 64)
    if (blockHash !== undefined && !HEX_64.test(blockHash)) {
      throw new NwcError('INVALID_RESPONSE', 'get_info block_hash must be 32-byte hex')
    }
    const blockHeight = isAbsent(result.block_height)
      ? undefined
      : positiveSafeInteger(result.block_height, 'block_height', true, 'INVALID_RESPONSE')
    return {
      methods,
      ...(extensions !== undefined ? { extensions } : {}),
      ...(alias !== undefined ? { alias } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(pubkey !== undefined ? { pubkey: pubkey.toLowerCase() } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(blockHeight !== undefined ? { block_height: blockHeight } : {}),
      ...(blockHash !== undefined ? { block_hash: blockHash.toLowerCase() } : {}),
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#capabilities = undefined
    const error = new NwcError('CLIENT_CLOSED', 'NWC client is closed')
    for (const cancel of [...this.#pending]) cancel(error)
    try {
      this.#transport.close(this.relays)
    } catch {
      // Key destruction and pending-request cancellation must still complete.
    } finally {
      this.#secretKey.fill(0)
      this.#conversationKey.fill(0)
    }
  }

  protected async execute(method: string, params: object, options: NwcRequestOptions = {}): Promise<unknown> {
    this.#assertOpen()
    const requestPlaintext = serialiseRequest(method, params)
    if (!this.#capabilities) await this.connect()
    if (!this.#capabilities?.methods.includes(method)) {
      throw new NwcError('UNSUPPORTED_METHOD', `NWC wallet does not advertise ${method}`)
    }

    const timeoutMs = validateTimeout(options.timeoutMs ?? this.#requestTimeoutMs)
    if (options.signal?.aborted) throw new NwcError('REQUEST_ABORTED', 'NWC request was aborted')
    const createdAt = this.#now()
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new NwcError('INVALID_REQUEST', 'now must return a non-negative Unix timestamp')
    }
    const expiresAt = createdAt + Math.ceil(timeoutMs / 1000) + 5
    if (!Number.isSafeInteger(expiresAt)) {
      throw new NwcError('INVALID_REQUEST', 'request expiration exceeds the safe timestamp range')
    }
    const event = finalizeEvent({
      kind: NWC_REQUEST_KIND,
      created_at: createdAt,
      tags: [
        ['p', this.walletPubkey],
        ['encryption', 'nip44_v2'],
        ['expiration', String(expiresAt)],
      ],
      content: nip44.v2.encrypt(requestPlaintext, this.#conversationKey),
    }, this.#secretKey)

    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let subscription: ReturnType<NwcTransport['subscribe']> | undefined

      const finish = (error?: NwcError, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.#pending.delete(cancel)
        try {
          subscription?.close('request complete')
        } catch {
          // Transport cleanup must not replace the request result.
        }
        if (error) reject(error)
        else resolve(value)
      }

      const onAbort = () => finish(new NwcError('REQUEST_ABORTED', 'NWC request was aborted'))
      const cancel = (error: NwcError) => finish(error)
      const timer = setTimeout(
        () => finish(new NwcError('RESPONSE_TIMEOUT', `NWC ${method} response timed out`)),
        timeoutMs,
      )
      this.#pending.add(cancel)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        onAbort()
        return
      }

      try {
        const activeSubscription = this.#transport.subscribe(
          this.relays,
          { kinds: [NWC_RESPONSE_KIND], authors: [this.walletPubkey], '#e': [event.id] },
          {
            onevent: (response: unknown) => {
              if (settled) return
              try {
                const value = this.#handleResponse(response, event.id, method)
                finish(undefined, value)
              } catch (error) {
                if (error instanceof NwcError && error.code === 'INVALID_RESPONSE') {
                  // Relay filters are only performance hints. A relay can replay
                  // any old, valid wallet event, so only a signed response that
                  // references this exact request may terminate it as invalid.
                  if (!isWalletResponseForRequest(response, this.walletPubkey, event.id)) return
                }
                finish(error instanceof NwcError ? error : new NwcError('INVALID_RESPONSE', 'NWC response processing failed'))
              }
            },
          },
          options.signal,
        )
        subscription = activeSubscription
        if (settled) {
          try {
            activeSubscription.close('request completed during subscription setup')
          } catch {
            // The request is already settled; cleanup failure cannot replace it.
          }
          return
        }
      } catch {
        finish(new NwcError('PUBLISH_FAILED', `Unable to subscribe for the NWC ${method} response`))
        return
      }

      void this.#transport.publish(this.relays, event, timeoutMs, options.signal)
        .then((results) => {
          if (!results.some((result) => result.accepted)) {
            finish(new NwcError('PUBLISH_FAILED', `No relay accepted the NWC ${method} request`))
          }
        })
        .catch(() => finish(new NwcError('PUBLISH_FAILED', `NWC ${method} request publication failed`)))
    })
  }

  /**
   * A wallet may declare an extension either by naming it in the `extensions`
   * tag or by naming the method it provides in the capability list.
   *
   * The tag is the tidier signal and the specification's intended one, but no
   * surveyed wallet service publishes it: not Alby Hub, not Coinos, not
   * `@getalby/sdk`, which is what Zeus speaks through. The extensions mechanism
   * arrived after `list_transactions` was already deployed, and nobody went
   * back. Requiring the tag therefore refuses every wallet that actually
   * implements the method, on the grounds that it did not say so twice.
   *
   * Accepting the method name is not a guess. It is the wallet's own explicit
   * capability declaration, and `execute` independently refuses any method
   * missing from that list. What guards the response is `validateTransaction`,
   * which is unaffected either way.
   */
  protected requireExtension(identifier: string, providedByMethod?: string): void {
    const capabilities = this.#capabilities
    if (capabilities?.extensions.includes(identifier)) return
    if (providedByMethod && capabilities?.methods.includes(providedByMethod)) return
    throw new NwcError('UNSUPPORTED_EXTENSION', `NWC wallet does not advertise extension ${identifier}`)
  }

  #handleResponse(response: unknown, requestId: string, method: string): unknown {
    if (
      !isNwcEventShape(response) ||
      response.kind !== NWC_RESPONSE_KIND ||
      response.pubkey !== this.walletPubkey ||
      response.content.length > MAX_RESPONSE_CONTENT_CHARS ||
      !verifyExternalEvent(response)
    ) {
      throw new NwcError('INVALID_RESPONSE', 'NWC response failed event authentication')
    }
    if (singleTag(response, 'e') !== requestId || singleTag(response, 'p') !== this.clientPubkey) {
      throw new NwcError('INVALID_RESPONSE', 'NWC response does not reference this request and client')
    }

    let plaintext: string
    try {
      plaintext = nip44.v2.decrypt(response.content, this.#conversationKey)
    } catch {
      throw new NwcError('INVALID_RESPONSE', 'NWC response decryption failed')
    }
    const payload = parseJsonRecord(plaintext)
    if (payload.result_type !== method) {
      throw new NwcError('INVALID_RESPONSE', 'NWC response result_type does not match the request')
    }

    // NIP-47 says the error field "must be null" on success, but the spec's own
    // worked example omits it and wallets follow the example: Alby Hub marshals
    // the field as `json:"error,omitempty"` over a nil pointer, so a successful
    // response carries no error key at all. Absent and null both mean success.
    if (payload.error !== null && payload.error !== undefined) {
      if (!isRecord(payload.error)) {
        throw new NwcError('INVALID_RESPONSE', 'NWC response has an invalid error field')
      }
      const walletCode = safeMessage(payload.error.code, 'OTHER')
      const message = safeMessage(payload.error.message, 'The NWC wallet rejected the request')
      throw new NwcError('WALLET_ERROR', message, walletCode)
    }
    if (!('result' in payload) || payload.result === null) {
      throw new NwcError('INVALID_RESPONSE', 'NWC response has no result')
    }
    return payload.result
  }

  protected validateTransaction(value: unknown, method: string): NwcTransaction {
    if (!isRecord(value)) throw new NwcError('INVALID_RESPONSE', `${method} result is not an object`)
    if (!isAbsent(value.payment_hash) && (typeof value.payment_hash !== 'string' || !HEX_64.test(value.payment_hash))) {
      throw new NwcError('INVALID_RESPONSE', `${method} returned an invalid payment_hash`)
    }
    if (!isAbsent(value.preimage) && (typeof value.preimage !== 'string' || !HEX_64.test(value.preimage))) {
      throw new NwcError('INVALID_RESPONSE', `${method} returned an invalid preimage`)
    }
    if (!isAbsent(value.invoice) && (typeof value.invoice !== 'string' || value.invoice.length > MAX_INVOICE_CHARS)) {
      throw new NwcError('INVALID_RESPONSE', `${method} returned an invalid invoice`)
    }
    if (!isAbsent(value.type) && value.type !== 'incoming' && value.type !== 'outgoing') {
      throw new NwcError('INVALID_RESPONSE', `${method} returned an invalid transaction type`)
    }
    if (!isAbsent(value.state) && !['pending', 'settled', 'accepted', 'expired', 'failed'].includes(value.state as string)) {
      throw new NwcError('INVALID_RESPONSE', `${method} returned an invalid transaction state`)
    }
    const description = isAbsent(value.description) ? undefined : optionalBoundedString(value.description, 'description')
    if (!isAbsent(value.description_hash) && (typeof value.description_hash !== 'string' || !HEX_64.test(value.description_hash))) {
      throw new NwcError('INVALID_RESPONSE', `${method} returned an invalid description_hash`)
    }
    if (!isAbsent(value.metadata)) {
      if (!isRecord(value.metadata)) throw new NwcError('INVALID_RESPONSE', `${method} returned invalid metadata`)
      try {
        if (JSON.stringify(value.metadata).length > MAX_METADATA_CHARS) {
          throw new NwcError('INVALID_RESPONSE', `${method} returned oversized metadata`)
        }
      } catch (error) {
        if (error instanceof NwcError) throw error
        throw new NwcError('INVALID_RESPONSE', `${method} returned invalid metadata`)
      }
    }
    for (const field of ['amount', 'fees_paid'] as const) {
      if (!isAbsent(value[field])) positiveSafeInteger(value[field], field, true, 'INVALID_RESPONSE')
    }
    for (const field of ['created_at', 'expires_at', 'settled_at'] as const) {
      if (isAbsent(value[field])) continue
      const seconds = positiveSafeInteger(value[field], field, true, 'INVALID_RESPONSE')
      // NIP-47 timestamps are Unix seconds. Wallets have shipped milliseconds
      // here by accident, which is a silent corruption rather than a loud one:
      // the value is a perfectly good positive integer, so it passes every
      // other check and lands in application code as a date roughly forty
      // thousand years out. Coinos hit this and it broke a client's date
      // parser. Anything past the year 2100 is not a Unix-seconds timestamp.
      if (seconds > MAX_TIMESTAMP_SECONDS) {
        throw new NwcError('INVALID_RESPONSE', `${method} returned ${field} outside the Unix-seconds range, possibly in milliseconds`)
      }
    }
    return {
      ...(isAbsent(value.type) ? {} : { type: value.type as 'incoming' | 'outgoing' }),
      ...(isAbsent(value.state) ? {} : { state: value.state as 'pending' | 'settled' | 'accepted' | 'expired' | 'failed' }),
      ...(isAbsent(value.invoice) ? {} : { invoice: value.invoice as string }),
      ...(description !== undefined ? { description } : {}),
      ...(isAbsent(value.description_hash) ? {} : { description_hash: (value.description_hash as string).toLowerCase() }),
      ...(isAbsent(value.payment_hash) ? {} : { payment_hash: (value.payment_hash as string).toLowerCase() }),
      ...(isAbsent(value.preimage) ? {} : { preimage: (value.preimage as string).toLowerCase() }),
      ...(isAbsent(value.amount) ? {} : { amount: value.amount as number }),
      ...(isAbsent(value.fees_paid) ? {} : { fees_paid: value.fees_paid as number }),
      ...(isAbsent(value.created_at) ? {} : { created_at: value.created_at as number }),
      ...(isAbsent(value.expires_at) ? {} : { expires_at: value.expires_at as number }),
      ...(isAbsent(value.settled_at) ? {} : { settled_at: value.settled_at as number }),
      ...(isAbsent(value.metadata) ? {} : { metadata: value.metadata as Record<string, unknown> }),
    }
  }

  #copyCapabilities(value: NwcCapabilities): NwcCapabilities {
    return {
      methods: [...value.methods],
      encryptions: [...value.encryptions],
      extensions: [...value.extensions],
      eventId: value.eventId,
      createdAt: value.createdAt,
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new NwcError('CLIENT_CLOSED', 'NWC client is closed')
  }
}
