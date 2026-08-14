import { describe, expect, it } from 'vitest'
import { NwcTransactionHistoryClient } from '../src/extensions/05.js'
import { FakeTransport, VALID_URI } from './helpers.js'

describe('NWC extension 05 transaction history', () => {
  it('lists transactions only when the wallet advertises extension 05', async () => {
    const transport = new FakeTransport()
    const client = new NwcTransactionHistoryClient(VALID_URI, { transport })
    await expect(client.listTransactions({ limit: 20, offset: 0, type: 'incoming' })).resolves.toMatchObject({
      transactions: [{ type: 'incoming', state: 'settled' }],
    })
    client.close()
  })

  it('always sends a page limit so the wallet cannot apply a larger default', async () => {
    const transport = new FakeTransport()
    let requested: Record<string, unknown> | undefined
    transport.responseFactory = (_request, _method, params) => {
      requested = params
      return { result: { transactions: [] }, error: null }
    }
    const client = new NwcTransactionHistoryClient(VALID_URI, { transport })
    await client.listTransactions()
    expect(requested).toMatchObject({ limit: 20 })

    await client.listTransactions({ limit: 5 })
    expect(requested).toMatchObject({ limit: 5 })
    client.close()
  })

  it('accepts a wallet that advertises the method but publishes no extensions tag', async () => {
    // No surveyed wallet service publishes an extensions tag. Alby Hub, Coinos
    // and @getalby/sdk all name list_transactions in the capability list and
    // stop there, so requiring the tag refuses every wallet that implements it.
    const transport = new FakeTransport()
    transport.infoExtensions = []
    const client = new NwcTransactionHistoryClient(VALID_URI, { transport })
    await expect(client.listTransactions()).resolves.toMatchObject({
      transactions: [{ type: 'incoming' }],
    })
    client.close()
  })

  it('fails closed when the wallet advertises neither the extension nor the method', async () => {
    const transport = new FakeTransport()
    transport.infoExtensions = []
    transport.infoMethods = ['get_balance', 'pay_invoice']
    const client = new NwcTransactionHistoryClient(VALID_URI, { transport })
    await expect(client.listTransactions()).rejects.toMatchObject({ code: 'UNSUPPORTED_EXTENSION' })
    client.close()
  })

  it('rejects a malformed transaction-history result', async () => {
    const transport = new FakeTransport()
    transport.responseFactory = () => ({ result: { transactions: 'not-an-array' }, error: null })
    const client = new NwcTransactionHistoryClient(VALID_URI, { transport })
    await expect(client.listTransactions()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    client.close()
  })

  it('bounds and validates returned transactions', async () => {
    const tooMany = new FakeTransport()
    tooMany.responseFactory = () => ({ result: { transactions: [{}, {}] }, error: null })
    await expect(new NwcTransactionHistoryClient(VALID_URI, { transport: tooMany }).listTransactions({ limit: 1 }))
      .rejects.toThrow('too many transactions')

    const malformed = new FakeTransport()
    malformed.responseFactory = () => ({ result: { transactions: [{ payment_hash: 'bad' }] }, error: null })
    await expect(new NwcTransactionHistoryClient(VALID_URI, { transport: malformed }).listTransactions())
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 21 }, 'limit'],
    [{ offset: -1 }, 'offset'],
    [{ from: 1.5 }, 'from'],
    [{ from: 2, until: 1 }, 'from must not be after until'],
    [{ unpaid: 'yes' }, 'unpaid'],
    [{ type: 'sideways' }, 'type'],
  ])('validates extension parameters', async (params, message) => {
    const client = new NwcTransactionHistoryClient(VALID_URI, { transport: new FakeTransport() })
    await expect(client.listTransactions(params as never)).rejects.toThrow(message)
    client.close()
  })
})
