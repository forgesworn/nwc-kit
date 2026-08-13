import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { NwcClient, NwcError } from '../src/index.js'
import type { NwcEvent, NwcPublishResult } from '../src/index.js'
import {
  CLIENT_PUBKEY,
  FakeTransport,
  VALID_URI,
  WALLET_PUBKEY,
  WALLET_SECRET,
} from './helpers.js'

function responseWithPlaintext(request: NwcEvent, plaintext: string, tags?: string[][]): NwcEvent {
  const conversationKey = nip44.v2.utils.getConversationKey(WALLET_SECRET, request.pubkey)
  return finalizeEvent({
    kind: 23_195,
    created_at: request.created_at + 1,
    tags: tags ?? [['p', request.pubkey], ['e', request.id]],
    content: nip44.v2.encrypt(plaintext, conversationKey),
  }, WALLET_SECRET)
}

describe('NwcClient capability discovery', () => {
  it('accepts the newest signed info event and returns defensive copies', async () => {
    const transport = new FakeTransport()
    const older = transport.createInfoEvent({ created_at: 100 })
    const newer = transport.createInfoEvent({ created_at: 200 })
    transport.infoEvents = [older, { ...newer, sig: '00'.repeat(64) }, newer]
    const client = new NwcClient(VALID_URI, { transport })

    const info = await client.connect()
    expect(info.eventId).toBe(newer.id)
    expect(info.methods).toContain('pay_invoice')
    expect(info.encryptions).toEqual(['nip44_v2'])
    expect(info.extensions).toEqual(['05'])
    ;(info.methods as string[]).push('forged')
    expect(client.capabilities?.methods).not.toContain('forged')
    expect(transport.queries[0]?.relays).toHaveLength(2)
    client.close()
  })

  it('fails closed without a signed info event or NIP-44 support', async () => {
    const missing = new FakeTransport()
    missing.infoEvents = []
    await expect(new NwcClient(VALID_URI, { transport: missing }).connect()).rejects.toMatchObject({ code: 'INFO_UNAVAILABLE' })

    const legacy = new FakeTransport()
    legacy.infoEncryptions = ['nip04']
    await expect(new NwcClient(VALID_URI, { transport: legacy }).connect()).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' })
  })

  it('rejects empty or duplicate info tags', async () => {
    const empty = new FakeTransport()
    empty.infoMethods = []
    await expect(new NwcClient(VALID_URI, { transport: empty }).connect()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const duplicate = new FakeTransport()
    const base = duplicate.createInfoEvent()
    duplicate.infoEvents = [finalizeEvent({
      kind: base.kind,
      created_at: base.created_at,
      tags: [...base.tags, ['encryption', 'nip44_v2']],
      content: base.content,
    }, WALLET_SECRET)]
    await expect(new NwcClient(VALID_URI, { transport: duplicate }).connect()).rejects.toThrow('duplicate encryption')
  })

  it('bounds capability events and ignores structurally invalid candidates', async () => {
    const oversized = new FakeTransport()
    oversized.infoEvents = [oversized.createInfoEvent({ content: 'x'.repeat(8193) })]
    await expect(new NwcClient(VALID_URI, { transport: oversized }).connect()).rejects.toMatchObject({ code: 'INFO_UNAVAILABLE' })

    const tooMany = new FakeTransport()
    tooMany.infoMethods = Array.from({ length: 129 }, (_, index) => `method_${index}`)
    await expect(new NwcClient(VALID_URI, { transport: tooMany }).connect()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const malformed = new FakeTransport()
    malformed.infoEvents = [{ ...malformed.createInfoEvent(), tags: null as never }]
    await expect(new NwcClient(VALID_URI, { transport: malformed }).connect()).rejects.toMatchObject({ code: 'INFO_UNAVAILABLE' })

    const tagFlood = new FakeTransport()
    tagFlood.infoEvents = [tagFlood.createInfoEvent({
      tags: Array.from({ length: 17 }, () => ['x', 'x'.repeat(4096)]),
    })]
    await expect(new NwcClient(VALID_URI, { transport: tagFlood }).connect()).rejects.toMatchObject({ code: 'INFO_UNAVAILABLE' })
  })

  it('normalises failed or invalid capability discovery', async () => {
    class RejectingTransport extends FakeTransport {
      override async query(): Promise<NwcEvent[]> {
        throw new Error('relay detail must not escape')
      }
    }
    await expect(new NwcClient(VALID_URI, { transport: new RejectingTransport() }).connect()).rejects.toMatchObject({
      code: 'INFO_UNAVAILABLE',
      message: 'NWC wallet capability discovery failed',
    })

    class FloodingTransport extends FakeTransport {
      override async query(): Promise<NwcEvent[]> {
        return Array.from({ length: 33 }, () => this.createInfoEvent())
      }
    }
    await expect(new NwcClient(VALID_URI, { transport: new FloodingTransport() }).connect()).rejects.toMatchObject({
      code: 'INFO_UNAVAILABLE',
    })
  })
})

describe('NwcClient core operations', () => {
  it('pays an invoice with authenticated NIP-44 request and response events', async () => {
    const transport = new FakeTransport()
    const client = new NwcClient(VALID_URI, { transport, now: () => 1_700_000_100 })
    const result = await client.payInvoice({ invoice: 'lnbc1valid', amount: 1_000, metadata: { comment: 'test' } })

    expect(result).toEqual({ preimage: 'ab'.repeat(32), fees_paid: 12 })
    const request = transport.requests[0]!
    expect(request.kind).toBe(23194)
    expect(request.pubkey).toBe(CLIENT_PUBKEY)
    expect(verifyEvent(request)).toBe(true)
    expect(request.tags).toContainEqual(['p', WALLET_PUBKEY])
    expect(request.tags).toContainEqual(['encryption', 'nip44_v2'])
    expect(request.tags).toContainEqual(['expiration', '1700000165'])
    expect(transport.subscriptions[0]).toMatchObject({ kinds: [23195], authors: [WALLET_PUBKEY], '#e': [request.id] })

    const conversationKey = nip44.v2.utils.getConversationKey(WALLET_SECRET, request.pubkey)
    expect(JSON.parse(nip44.v2.decrypt(request.content, conversationKey))).toEqual({
      method: 'pay_invoice',
      params: { invoice: 'lnbc1valid', amount: 1_000, metadata: { comment: 'test' } },
    })
    client.close()
  })

  it('supports all core response shapes', async () => {
    const transport = new FakeTransport()
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.makeInvoice({ amount: 1_000, description: 'test', expiry: 60 })).resolves.toMatchObject({ payment_hash: 'cd'.repeat(32) })
    await expect(client.lookupInvoice({ payment_hash: 'cd'.repeat(32) })).resolves.toMatchObject({ state: 'settled' })
    await expect(client.lookupInvoice({ invoice: 'lnbc1lookup' })).resolves.toMatchObject({ state: 'settled' })
    await expect(client.getBalance()).resolves.toEqual({ balance: 42_000 })
    await expect(client.getInfo()).resolves.toMatchObject({ network: 'mainnet' })
    client.close()
  })

  it('validates request fields before publishing', async () => {
    const client = new NwcClient(VALID_URI, { transport: new FakeTransport() })
    await expect(client.payInvoice({ invoice: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.payInvoice({ invoice: 'x'.repeat(20_001) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.payInvoice({ invoice: 'lnbc', amount: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.payInvoice({ invoice: 'lnbc', metadata: { value: 'x'.repeat(5000) } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.payInvoice({ invoice: 'lnbc', metadata: [] as never })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.payInvoice({ invoice: 'lnbc', metadata: { value: 1n } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.makeInvoice({ amount: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.makeInvoice({ amount: 1, description: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.makeInvoice({ amount: 1, description: 7 as never })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.makeInvoice({ amount: 1, description_hash: 'bad' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.makeInvoice({ amount: 1, description: 'one', description_hash: 'ab'.repeat(32) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.lookupInvoice({})).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.lookupInvoice({ payment_hash: 'bad' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client.lookupInvoice({ payment_hash: 'ab'.repeat(32), invoice: 'lnbc1both' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    client.close()
  })

  it('rejects request timestamps whose expiration would overflow', async () => {
    const transport = new FakeTransport()
    const client = new NwcClient(VALID_URI, { transport, now: () => Number.MAX_SAFE_INTEGER })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(transport.requests).toHaveLength(0)
    client.close()
  })

  it('snapshots caller metadata before asynchronous discovery', async () => {
    const transport = new FakeTransport()
    const metadata = { comment: 'approved' }
    const payment = new NwcClient(VALID_URI, { transport }).payInvoice({ invoice: 'lnbc1', metadata })
    metadata.comment = 'mutated after approval'
    await expect(payment).resolves.toMatchObject({ preimage: 'ab'.repeat(32) })

    const request = transport.requests[0]!
    const conversationKey = nip44.v2.utils.getConversationKey(WALLET_SECRET, request.pubkey)
    expect(JSON.parse(nip44.v2.decrypt(request.content, conversationKey))).toMatchObject({
      params: { metadata: { comment: 'approved' } },
    })
  })

  it('rejects methods not advertised by the wallet', async () => {
    const transport = new FakeTransport()
    transport.infoMethods = ['get_balance']
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' })
    client.close()
  })

  it('surfaces bounded wallet errors without control characters', async () => {
    const transport = new FakeTransport()
    transport.responseFactory = () => ({ error: { code: 'QUOTA_EXCEEDED\n', message: 'limit\u0000 reached' } })
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({
      code: 'WALLET_ERROR',
      walletCode: 'QUOTA_EXCEEDED',
      message: 'limit  reached',
    })
    client.close()
  })

  it('rejects mismatched result types and malformed results', async () => {
    const mismatch = new FakeTransport()
    mismatch.responseFactory = () => ({ resultType: 'get_balance', result: { preimage: 'ab'.repeat(32) }, error: null })
    await expect(new NwcClient(VALID_URI, { transport: mismatch }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const malformed = new FakeTransport()
    malformed.responseFactory = () => ({ result: { preimage: 'not-a-preimage' }, error: null })
    await expect(new NwcClient(VALID_URI, { transport: malformed }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const badFees = new FakeTransport()
    badFees.responseFactory = () => ({ result: { preimage: 'ab'.repeat(32), fees_paid: -1 }, error: null })
    await expect(new NwcClient(VALID_URI, { transport: badFees }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('strictly validates transaction, balance, and wallet-info results', async () => {
    const transactionCases: unknown[] = [
      'not-an-object',
      { payment_hash: 'bad' },
      { preimage: 'bad' },
      { invoice: '' },
      { type: 'sideways' },
      { state: 'unknown' },
      { amount: -1 },
      { description: 7 },
      { description_hash: 'bad' },
      { metadata: [] },
      { metadata: { value: 'x'.repeat(5000) } },
    ]
    for (const result of transactionCases) {
      const transport = new FakeTransport()
      transport.responseFactory = () => ({ result, error: null })
      await expect(new NwcClient(VALID_URI, { transport }).makeInvoice({ amount: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }

    const badBalance = new FakeTransport()
    badBalance.responseFactory = () => ({ result: { balance: -1 }, error: null })
    await expect(new NwcClient(VALID_URI, { transport: badBalance }).getBalance()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    for (const result of [
      null,
      { methods: [1] },
      { methods: Array.from({ length: 129 }, () => 'method') },
      { methods: ['x'.repeat(129)] },
      { methods: [], extensions: [1] },
      { methods: [], pubkey: 'bad' },
      { methods: [], block_hash: 'bad' },
      { methods: [], block_height: -1 },
    ]) {
      const transport = new FakeTransport()
      transport.responseFactory = () => ({ result, error: null })
      await expect(new NwcClient(VALID_URI, { transport }).getInfo()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }

    const bounded = new FakeTransport()
    bounded.responseFactory = () => ({ result: { methods: [], alias: 'x'.repeat(4097) }, error: null })
    await expect(new NwcClient(VALID_URI, { transport: bounded }).getInfo()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('returns only validated transaction fields', async () => {
    const transport = new FakeTransport()
    transport.responseFactory = () => ({
      result: {
        type: 'incoming',
        state: 'settled',
        invoice: 'lnbc1safe',
        description: 'safe',
        description_hash: 'CD'.repeat(32),
        payment_hash: 'AB'.repeat(32),
        preimage: 'EF'.repeat(32),
        amount: 1_000,
        fees_paid: 0,
        created_at: 1,
        expires_at: 2,
        settled_at: 3,
        metadata: { source: 'wallet' },
        unrecognised: 'drop me',
      },
      error: null,
    })
    const result = await new NwcClient(VALID_URI, { transport }).makeInvoice({ amount: 1_000 })
    expect(result).toEqual({
      type: 'incoming',
      state: 'settled',
      invoice: 'lnbc1safe',
      description: 'safe',
      description_hash: 'cd'.repeat(32),
      payment_hash: 'ab'.repeat(32),
      preimage: 'ef'.repeat(32),
      amount: 1_000,
      fees_paid: 0,
      created_at: 1,
      expires_at: 2,
      settled_at: 3,
      metadata: { source: 'wallet' },
    })
    expect(result).not.toHaveProperty('unrecognised')
  })

  it('rejects authenticated malformed, undecryptable, and ambiguous responses', async () => {
    const malformedJson = new FakeTransport()
    malformedJson.beforeValidResponse = (request, deliver) => deliver(responseWithPlaintext(request, '[]'))
    await expect(new NwcClient(VALID_URI, { transport: malformedJson }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const invalidError = new FakeTransport()
    invalidError.beforeValidResponse = (request, deliver) => deliver(responseWithPlaintext(request, JSON.stringify({
      result_type: 'pay_invoice', error: 'bad', result: {},
    })))
    await expect(new NwcClient(VALID_URI, { transport: invalidError }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const missingResult = new FakeTransport()
    missingResult.beforeValidResponse = (request, deliver) => deliver(responseWithPlaintext(request, JSON.stringify({
      result_type: 'pay_invoice', error: null,
    })))
    await expect(new NwcClient(VALID_URI, { transport: missingResult }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const duplicateTag = new FakeTransport()
    duplicateTag.beforeValidResponse = (request, deliver) => deliver(responseWithPlaintext(
      request,
      JSON.stringify({ result_type: 'pay_invoice', error: null, result: { preimage: 'ab'.repeat(32) } }),
      [['p', request.pubkey], ['e', request.id], ['e', request.id]],
    ))
    await expect(new NwcClient(VALID_URI, { transport: duplicateTag }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const undecryptable = new FakeTransport()
    undecryptable.beforeValidResponse = (request, deliver) => deliver(finalizeEvent({
      kind: 23_195,
      created_at: request.created_at + 1,
      tags: [['p', request.pubkey], ['e', request.id]],
      content: 'not-nip44',
    }, WALLET_SECRET))
    await expect(new NwcClient(VALID_URI, { transport: undecryptable }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const oversized = new FakeTransport()
    oversized.beforeValidResponse = (request, deliver) => deliver(finalizeEvent({
      kind: 23_195,
      created_at: request.created_at + 1,
      tags: [['p', request.pubkey], ['e', request.id]],
      content: 'x'.repeat(131_073),
    }, WALLET_SECRET))
    await expect(new NwcClient(VALID_URI, { transport: oversized }).payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('ignores an unauthenticated injected response before accepting the wallet response', async () => {
    const transport = new FakeTransport()
    transport.beforeValidResponse = (request, deliver) => {
      const valid = transport.createResponseEvent(request, {
        result_type: 'pay_invoice', error: null, result: { preimage: 'ff'.repeat(32) },
      })
      deliver({ ...valid, sig: '00'.repeat(64) })
    }
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).resolves.toMatchObject({ preimage: 'ab'.repeat(32) })
    client.close()
  })

  it('ignores an authenticated wallet response replayed from another request', async () => {
    const transport = new FakeTransport()
    transport.beforeValidResponse = (request, deliver) => {
      deliver(transport.createResponseEvent(request, {
        result_type: 'pay_invoice', error: null, result: { preimage: 'ff'.repeat(32) },
      }, [['p', request.pubkey], ['e', '00'.repeat(32)]]))
    }
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).resolves.toMatchObject({ preimage: 'ab'.repeat(32) })
    client.close()
  })

  it('ignores structurally malformed injected responses', async () => {
    const transport = new FakeTransport()
    transport.beforeValidResponse = (_request, deliver) => deliver(null as never)
    await expect(new NwcClient(VALID_URI, { transport }).payInvoice({ invoice: 'lnbc1' }))
      .resolves.toMatchObject({ preimage: 'ab'.repeat(32) })
  })

  it('cleans up and does not publish if subscription setup settles the request', async () => {
    const transport = new FakeTransport()
    transport.beforeSubscriptionReturn = (filter, deliver) => {
      const requestId = filter['#e']?.[0]
      expect(requestId).toBeDefined()
      const conversationKey = nip44.v2.utils.getConversationKey(WALLET_SECRET, CLIENT_PUBKEY)
      deliver(finalizeEvent({
        kind: 23_195,
        created_at: 1_700_000_001,
        tags: [['p', CLIENT_PUBKEY], ['e', requestId!]],
        content: nip44.v2.encrypt('[]', conversationKey),
      }, WALLET_SECRET))
    }
    await expect(new NwcClient(VALID_URI, { transport }).payInvoice({ invoice: 'lnbc1' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(transport.requests).toHaveLength(0)
    expect(transport.closeCount).toBe(1)
  })

  it('rejects an authenticated wallet response addressed to the wrong client', async () => {
    const transport = new FakeTransport()
    transport.beforeValidResponse = (request, deliver) => {
      deliver(transport.createResponseEvent(request, {
        result_type: 'pay_invoice', error: null, result: { preimage: 'ab'.repeat(32) },
      }, [['p', '00'.repeat(32)], ['e', request.id]]))
    }
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    client.close()
  })

  it('fails when no relay accepts publication', async () => {
    const transport = new FakeTransport()
    transport.acceptPublish = false
    transport.respond = false
    const client = new NwcClient(VALID_URI, { transport })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({ code: 'PUBLISH_FAILED' })
    client.close()
  })

  it('supports abort and timeout without leaving a subscription open', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      transport.respond = false
      const controller = new AbortController()
      controller.abort()
      await expect(new NwcClient(VALID_URI, { transport }).payInvoice(
        { invoice: 'lnbc1' },
        { signal: controller.signal },
      )).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })

      const activeController = new AbortController()
      const aborted = new NwcClient(VALID_URI, { transport }).payInvoice(
        { invoice: 'lnbc1' },
        { signal: activeController.signal },
      )
      const abortedExpectation = expect(aborted).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
      activeController.abort()
      await abortedExpectation

      const timeoutTransport = new FakeTransport()
      timeoutTransport.respond = false
      const timed = new NwcClient(VALID_URI, { transport: timeoutTransport, requestTimeoutMs: 100 }).payInvoice({ invoice: 'lnbc1' })
      const timedExpectation = expect(timed).rejects.toMatchObject({ code: 'RESPONSE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(101)
      await timedExpectation
      expect(timeoutTransport.closeCount).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish when abort races listener registration', async () => {
    const transport = new FakeTransport()
    let abortedReads = 0
    const signal = {
      get aborted() {
        abortedReads++
        return abortedReads > 1
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal
    await expect(new NwcClient(VALID_URI, { transport }).payInvoice(
      { invoice: 'lnbc1' },
      { signal },
    )).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(transport.requests).toHaveLength(0)
    expect(transport.subscriptions).toHaveLength(0)
  })

  it('refuses operations after close and validates timeout bounds', async () => {
    expect(() => new NwcClient(VALID_URI, { requestTimeoutMs: 99 })).toThrow('timeout')
    expect(() => new NwcClient(VALID_URI, { infoTimeoutMs: 300_001 })).toThrow('timeout')
    const client = new NwcClient(VALID_URI, { transport: new FakeTransport() })
    client.close()
    await expect(client.getBalance()).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    expect(() => client.close()).not.toThrow()
  })

  it('refuses invalid timestamps from an injected clock', async () => {
    for (const now of [() => -1, () => 1.5, () => Number.NaN]) {
      const client = new NwcClient(VALID_URI, { transport: new FakeTransport(), now })
      await expect(client.getBalance()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      client.close()
    }
  })

  it('cancels an in-flight request immediately on close', async () => {
    const transport = new FakeTransport()
    transport.respond = false
    const client = new NwcClient(VALID_URI, { transport })
    const pending = client.payInvoice({ invoice: 'lnbc1' })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1))
    client.close()
    await rejection
    expect(transport.closeCount).toBeGreaterThanOrEqual(2)
  })

  it('normalises subscription failure and tolerates cleanup failure', async () => {
    class BrokenTransport extends FakeTransport {
      override subscribe(): never {
        throw new Error('private transport detail')
      }

      override close(): never {
        throw new Error('cleanup failed')
      }
    }
    const client = new NwcClient(VALID_URI, { transport: new BrokenTransport() })
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
      message: 'Unable to subscribe for the NWC pay_invoice response',
    })
    expect(() => client.close()).not.toThrow()
  })

  it('uses NwcError for expected failures', async () => {
    const transport = new FakeTransport()
    transport.respond = false
    transport.acceptPublish = false
    await expect(new NwcClient(VALID_URI, { transport }).payInvoice({ invoice: 'lnbc1' })).rejects.toBeInstanceOf(NwcError)
  })

  it('normalises transport publication rejection', async () => {
    class RejectingTransport extends FakeTransport {
      override async publish(): Promise<NwcPublishResult[]> {
        throw new Error('relay details must not escape')
      }
    }
    const client = new NwcClient(VALID_URI, { transport: new RejectingTransport() })
    expect(client.capabilities).toBeUndefined()
    await expect(client.payInvoice({ invoice: 'lnbc1' })).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
      message: 'NWC pay_invoice request publication failed',
    })
    client.close()
  })
})
