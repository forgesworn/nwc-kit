/**
 * Live demo for the nwc-kit site.
 *
 * Everything here drives the real library. The simulated mode is not a mock of
 * nwc-kit — it is a mock *wallet*, sitting behind the real NwcClient, exchanging
 * real signed Nostr events with real NIP-44 v2 encryption. What you watch in the
 * protocol tape is the shipped code accepting and rejecting genuine traffic.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { NwcClient, NwcError } from '../src/index.js'
import { NwcTransactionHistoryClient } from '../src/extensions/05.js'
import type {
  NwcEvent,
  NwcFilter,
  NwcPublishResult,
  NwcSubscription,
  NwcTransport,
} from '../src/types.js'

type LogKind = 'send' | 'recv' | 'ok' | 'reject' | 'info'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function randomHex(byteLength: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)))
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing element #${id}`)
  return found as T
}

function truncate(value: string, keep = 16): string {
  return value.length <= keep * 2 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`
}

function formatMsats(msats: number): string {
  const sats = msats / 1000
  const formatted = Number.isInteger(sats) ? sats.toLocaleString('en-GB') : sats.toLocaleString('en-GB', { maximumFractionDigits: 3 })
  return `${formatted} sats`
}

// ── protocol tape ───────────────────────────────────────────────────────────

const tape = element<HTMLDivElement>('tape')
const tapeEmpty = element<HTMLParagraphElement>('tape-empty')

function log(kind: LogKind, title: string, detail?: string): void {
  tapeEmpty.hidden = true
  const entry = document.createElement('div')
  entry.className = `tape-entry tape-${kind}`

  const head = document.createElement('div')
  head.className = 'tape-head'

  const marker = document.createElement('span')
  marker.className = 'tape-marker'
  marker.textContent = { send: '→', recv: '←', ok: '✓', reject: '✗', info: '·' }[kind]

  const label = document.createElement('span')
  label.className = 'tape-title'
  label.textContent = title

  head.append(marker, label)
  entry.append(head)

  if (detail) {
    const body = document.createElement('pre')
    body.className = 'tape-detail'
    body.textContent = detail
    entry.append(body)
  }

  tape.append(entry)
  tape.scrollTop = tape.scrollHeight
}

function logEvent(kind: LogKind, title: string, event: NwcEvent): void {
  log(kind, title, [
    `kind    ${event.kind}`,
    `id      ${truncate(event.id)}`,
    `pubkey  ${truncate(event.pubkey)}`,
    `tags    ${JSON.stringify(event.tags.map((tag) => [tag[0], truncate(tag[1] ?? '', 8)]))}`,
    `content ${truncate(event.content, 24)}  (NIP-44 v2 ciphertext)`,
    `sig     ${truncate(event.sig, 12)}`,
  ].join('\n'))
}

function clearTape(): void {
  tape.replaceChildren(tapeEmpty)
  tapeEmpty.hidden = false
}

// ── simulated wallet ────────────────────────────────────────────────────────

type Scenario =
  | 'honest'
  | 'omits-error'
  | 'forged-signature'
  | 'impostor'
  | 'replay'
  | 'wrong-method'
  | 'wrong-recipient'
  | 'declines'

interface LedgerEntry {
  type: 'incoming' | 'outgoing'
  state: 'settled' | 'pending'
  invoice?: string
  payment_hash: string
  preimage?: string
  amount: number
  fees_paid?: number
  created_at: number
  settled_at?: number
  description?: string
}

const METHODS = ['pay_invoice', 'make_invoice', 'lookup_invoice', 'get_balance', 'get_info', 'list_transactions']

/**
 * Scenarios whose response cannot be attributed to the wallet for this request,
 * so the client drops the event silently and keeps waiting rather than letting
 * an unauthenticated party settle it.
 */
const IGNORED_SCENARIOS = new Set<Scenario>(['forged-signature', 'impostor', 'replay'])

/** Short enough that the demo's timeout path is watchable. */
const DEMO_TIMEOUT_MS = 8000

/**
 * A wallet service that happens to live in this page. It signs its own events
 * and encrypts to the client exactly as a real NWC wallet does, so the client
 * under test cannot tell the difference — which is the point.
 */
class SimulatedWallet implements NwcTransport {
  readonly secretKey = generateSecretKey()
  readonly pubkey = getPublicKey(this.secretKey)
  scenario: Scenario = 'honest'
  balance = 250_000_000
  readonly ledger: LedgerEntry[] = []

  #handler: ((event: NwcEvent) => void) | undefined
  #lastRequestId: string | undefined

  async query(_relays: readonly string[], _filter: NwcFilter, _timeoutMs: number): Promise<NwcEvent[]> {
    log('send', 'client → relay: capability discovery', 'REQ kinds=[13194] authors=[wallet] limit=5')
    const info = finalizeEvent({
      kind: 13194,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      tags: [
        ['encryption', 'nip44_v2 nip04'],
        ['extensions', '05'],
      ],
      content: METHODS.join(' '),
    }, this.secretKey)
    log('recv', 'wallet → client: signed info event (kind 13194)', [
      `methods    ${METHODS.join(' ')}`,
      `encryption nip44_v2 nip04`,
      `extensions 05`,
      `sig        ${truncate(info.sig, 12)}`,
    ].join('\n'))
    return [info]
  }

  subscribe(
    _relays: readonly string[],
    filter: NwcFilter,
    handlers: { onevent(event: NwcEvent): void; onclose?(): void },
  ): NwcSubscription {
    this.#handler = handlers.onevent
    const tagged = filter['#e']?.[0]
    log('info', 'client subscribes for the response', `REQ kinds=[23195] authors=[wallet] #e=[${truncate(tagged ?? '', 8)}]`)
    return {
      close: () => {
        this.#handler = undefined
      },
    }
  }

  async publish(relays: readonly string[], event: NwcEvent, _timeoutMs: number): Promise<NwcPublishResult[]> {
    logEvent('send', 'client → wallet: request event (kind 23194)', event)
    this.#lastRequestId = event.id

    const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, event.pubkey)
    const plaintext = nip44.v2.decrypt(event.content, conversationKey)
    const request = JSON.parse(plaintext) as { method: string; params: Record<string, unknown> }
    log('info', `wallet decrypts: ${request.method}`, JSON.stringify(request.params, null, 2))

    queueMicrotask(() => {
      if (!this.#handler) return
      const response = this.#buildResponse(request, event, conversationKey)
      logEvent('recv', 'wallet → client: response event (kind 23195)', response)
      this.#handler(response)

      // An event that fails authentication is discarded rather than allowed to
      // settle the request. That is the whole point: an impostor or a relay
      // holding an old event must not be able to cancel a payment you are
      // waiting on. The request stays open and times out on its own terms.
      if (IGNORED_SCENARIOS.has(this.scenario)) {
        log('info', 'nwc-kit discarded that event', [
          'It failed authentication, so it was dropped instead of failing the',
          'request. A hostile relay cannot cancel a request it cannot forge.',
          '',
          'The request stays open and will end in RESPONSE_TIMEOUT, which is an',
          'ambiguous outcome, never proof that the payment did not happen.',
        ].join('\n'))
      }
    })

    return relays.map((relay) => ({ relay, accepted: true }))
  }

  close(): void {
    this.#handler = undefined
  }

  #buildResponse(
    request: { method: string; params: Record<string, unknown> },
    requestEvent: NwcEvent,
    conversationKey: Uint8Array,
  ): NwcEvent {
    const scenario = this.scenario
    const payload = this.#result(request)

    const body: Record<string, unknown> = {
      result_type: scenario === 'wrong-method' ? 'get_info' : request.method,
      result: payload,
    }
    if (scenario === 'declines') {
      body.result = null
      body.error = { code: 'INSUFFICIENT_BALANCE', message: 'The demo wallet declined this request.' }
    } else if (scenario !== 'omits-error') {
      // The honest path. Note that "omits-error" is not hostile: it is the shape
      // Alby Hub actually sends, and the client must accept it.
      body.error = null
    }

    const signingKey = scenario === 'impostor' ? generateSecretKey() : this.secretKey
    const recipient = scenario === 'wrong-recipient' ? getPublicKey(generateSecretKey()) : requestEvent.pubkey
    const reference = scenario === 'replay' ? randomHex(32) : requestEvent.id

    const signed = finalizeEvent({
      kind: 23195,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipient], ['e', reference]],
      content: nip44.v2.encrypt(JSON.stringify(body), conversationKey),
    }, signingKey)

    if (scenario === 'forged-signature') {
      return { ...signed, sig: randomHex(64) }
    }
    return signed
  }

  #result(request: { method: string; params: Record<string, unknown> }): unknown {
    const now = Math.floor(Date.now() / 1000)
    switch (request.method) {
      case 'get_balance':
        return { balance: this.balance }
      case 'get_info':
        return { alias: 'nwc-kit demo wallet', network: 'mainnet', methods: METHODS, extensions: ['05'] }
      case 'pay_invoice': {
        const amount = 21_000
        const fees = 1_000
        this.balance -= amount + fees
        const entry: LedgerEntry = {
          type: 'outgoing',
          state: 'settled',
          payment_hash: randomHex(32),
          preimage: randomHex(32),
          amount,
          fees_paid: fees,
          created_at: now,
          settled_at: now,
          description: 'Demo payment',
        }
        this.ledger.unshift(entry)
        return { preimage: entry.preimage, fees_paid: fees }
      }
      case 'make_invoice': {
        const amount = Number(request.params.amount ?? 21_000)
        const entry: LedgerEntry = {
          type: 'incoming',
          state: 'pending',
          invoice: `lnbc${Math.round(amount / 1000)}n1demo${randomHex(24)}`,
          payment_hash: randomHex(32),
          amount,
          created_at: now,
          ...(typeof request.params.description === 'string' ? { description: request.params.description } : {}),
        }
        this.ledger.unshift(entry)
        return entry
      }
      case 'lookup_invoice':
        return this.ledger[0] ?? { type: 'incoming', state: 'expired', payment_hash: randomHex(32), amount: 0 }
      case 'list_transactions': {
        const limit = Number(request.params.limit ?? 20)
        return { transactions: this.ledger.slice(0, limit) }
      }
      default:
        return {}
    }
  }

  connectionUri(): string {
    const secret = randomHex(32)
    return `nostr+walletconnect://${this.pubkey}?relay=${encodeURIComponent('wss://relay.demo.invalid')}&secret=${secret}`
  }
}

// ── application state ───────────────────────────────────────────────────────

let wallet = new SimulatedWallet()
let client: NwcTransactionHistoryClient | undefined
let realClient: NwcTransactionHistoryClient | undefined

const status = element<HTMLDivElement>('demo-status')
const balanceOut = element<HTMLSpanElement>('wallet-balance')
const scenarioSelect = element<HTMLSelectElement>('scenario')

function setStatus(text: string, kind: 'idle' | 'busy' | 'ok' | 'error' = 'idle'): void {
  status.textContent = text
  status.dataset.kind = kind
}

function refreshBalance(): void {
  balanceOut.textContent = formatMsats(wallet.balance)
}

function describeError(error: unknown): string {
  if (error instanceof NwcError) {
    return error.walletCode ? `${error.code} (${error.walletCode}): ${error.message}` : `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Runs an action against whichever client the active mode owns. */
async function run(label: string, action: (client: NwcTransactionHistoryClient) => Promise<unknown>): Promise<void> {
  const active = mode === 'simulated' ? client : realClient
  if (!active) {
    setStatus('Connect first.', 'error')
    return
  }
  setStatus(`${label}…`, 'busy')
  try {
    const result = await action(active)
    log('ok', `${label} succeeded`, JSON.stringify(result, null, 2))
    setStatus(`${label} succeeded.`, 'ok')
  } catch (error) {
    const message = describeError(error)
    log('reject', `${label} rejected by nwc-kit`, message)
    setStatus(message, 'error')
  } finally {
    refreshBalance()
  }
}

// ── mode switching ──────────────────────────────────────────────────────────

type Mode = 'simulated' | 'real'
let mode: Mode = 'simulated'

const simulatedPanel = element<HTMLDivElement>('panel-simulated')
const realPanel = element<HTMLDivElement>('panel-real')

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => {
    mode = button.dataset.mode as Mode
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      other.setAttribute('aria-selected', String(other === button))
    }
    simulatedPanel.hidden = mode !== 'simulated'
    realPanel.hidden = mode !== 'real'
    clearTape()
    setStatus(mode === 'simulated' ? 'Simulated wallet ready.' : 'Paste a connection string to begin.')
  })
}

scenarioSelect.addEventListener('change', () => {
  wallet.scenario = scenarioSelect.value as Scenario
  const note = scenarioSelect.selectedOptions[0]?.dataset.note
  if (note) log('info', `Wallet behaviour: ${scenarioSelect.selectedOptions[0]?.textContent}`, note)
})

// ── simulated controls ──────────────────────────────────────────────────────

element<HTMLButtonElement>('sim-connect').addEventListener('click', async () => {
  client?.close()
  wallet = new SimulatedWallet()
  wallet.scenario = scenarioSelect.value as Scenario
  clearTape()
  refreshBalance()
  const uri = wallet.connectionUri()
  log('info', 'Connection string parsed', [
    'nostr+walletconnect://<wallet pubkey>?relay=…&secret=<32-byte hex>',
    '',
    'The secret never leaves the page and is never logged. nwc-kit converts it',
    'to owned byte arrays and zeroises them on close().',
  ].join('\n'))
  client = new NwcTransactionHistoryClient(uri, { transport: wallet, requestTimeoutMs: DEMO_TIMEOUT_MS })
  setStatus('Discovering capabilities…', 'busy')
  try {
    const capabilities = await client.connect()
    log('ok', 'Capabilities accepted', JSON.stringify(capabilities, null, 2))
    setStatus('Connected.', 'ok')
  } catch (error) {
    log('reject', 'Connection rejected by nwc-kit', describeError(error))
    setStatus(describeError(error), 'error')
  }
})

element<HTMLButtonElement>('sim-balance').addEventListener('click', () => run('get_balance', (c) => c.getBalance()))
element<HTMLButtonElement>('sim-info').addEventListener('click', () => run('get_info', (c) => c.getInfo()))
element<HTMLButtonElement>('sim-pay').addEventListener('click', () =>
  run('pay_invoice', (c) => c.payInvoice({ invoice: `lnbc210n1demo${randomHex(24)}` })))
element<HTMLButtonElement>('sim-invoice').addEventListener('click', () =>
  run('make_invoice', (c) => c.makeInvoice({ amount: 21_000, description: 'Demo invoice' })))
element<HTMLButtonElement>('sim-history').addEventListener('click', () =>
  run('list_transactions', (c) => c.listTransactions()))
element<HTMLButtonElement>('sim-clear').addEventListener('click', () => {
  clearTape()
  setStatus('Tape cleared.')
})

// ── real wallet controls ────────────────────────────────────────────────────

const uriInput = element<HTMLInputElement>('real-uri')
const realInvoice = element<HTMLInputElement>('real-invoice')

element<HTMLButtonElement>('real-connect').addEventListener('click', async () => {
  const uri = uriInput.value.trim()
  if (!uri) {
    setStatus('Paste a connection string first.', 'error')
    return
  }
  realClient?.close()
  clearTape()
  setStatus('Connecting over your relays…', 'busy')
  log('info', 'Connecting with your own wallet', [
    'This page holds the connection string in memory only. It is never written',
    'to storage, never placed in the URL, and never sent anywhere but the relays',
    'named inside the string itself.',
  ].join('\n'))
  try {
    realClient = new NwcTransactionHistoryClient(uri)
    log('info', 'Connection string accepted', `wallet ${truncate(realClient.walletPubkey)}\nrelays  ${realClient.relays.join(', ')}`)
    const capabilities = await realClient.connect()
    log('ok', 'Wallet capabilities', JSON.stringify(capabilities, null, 2))
    setStatus('Connected to your wallet.', 'ok')
  } catch (error) {
    log('reject', 'Connection failed', describeError(error))
    setStatus(describeError(error), 'error')
  }
})

element<HTMLButtonElement>('real-balance').addEventListener('click', () => run('get_balance', (c) => c.getBalance()))
element<HTMLButtonElement>('real-info').addEventListener('click', () => run('get_info', (c) => c.getInfo()))
element<HTMLButtonElement>('real-history').addEventListener('click', () =>
  run('list_transactions', (c) => c.listTransactions({ limit: 5 })))
element<HTMLButtonElement>('real-pay').addEventListener('click', () => {
  const invoice = realInvoice.value.trim()
  if (!invoice) {
    setStatus('Paste a BOLT-11 invoice to pay.', 'error')
    return
  }
  if (!confirm('This spends real satoshis from the connected wallet. Continue?')) return
  void run('pay_invoice', (c) => c.payInvoice({ invoice }))
})

element<HTMLButtonElement>('real-disconnect').addEventListener('click', () => {
  realClient?.close()
  realClient = undefined
  uriInput.value = ''
  realInvoice.value = ''
  log('info', 'Disconnected', 'close() cancelled pending requests and zeroised the owned key material.')
  setStatus('Disconnected.')
})

// ── boot ────────────────────────────────────────────────────────────────────

refreshBalance()
setStatus('Simulated wallet ready.')
window.addEventListener('beforeunload', () => {
  client?.close()
  realClient?.close()
})
