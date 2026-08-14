/**
 * Fixtures taken from what shipping wallet services actually put on the wire,
 * rather than from what the specification's prose describes.
 *
 * Every entry here corresponds to a real serialiser. Go marshals an unset
 * string as `""` and a nil pointer as `null` unless the struct tag carries
 * `omitempty`, and Alby Hub's NIP-47 structs mostly do not carry it, so its
 * ordinary responses are full of empty strings and nulls where a literal
 * reading of the spec would expect the field to be missing.
 *
 * These are regression tests for interop, not for correctness of validation:
 * malformed values still belong in client.test.ts, where they are refused.
 */
import { describe, expect, it } from 'vitest'
import { NwcClient } from '../src/index.js'
import { NwcTransactionHistoryClient } from '../src/extensions/05.js'
import { FakeTransport, VALID_URI } from './helpers.js'

// getAlby/hub nip47/models/models.go — Transaction. No omitempty on the string
// fields; ExpiresAt and SettledAt are *int64.
const ALBY_PENDING_INVOICE = {
  type: 'incoming',
  state: 'pending',
  invoice: 'lnbc10n1pexample',
  description: '',
  description_hash: '',
  preimage: '',
  payment_hash: 'ab'.repeat(32),
  amount: 1000,
  fees_paid: 0,
  created_at: 1786600000,
  expires_at: null,
  settled_at: null,
}

// getAlby/hub nip47/controllers/get_info_controller.go — every optional field
// is a nil-able pointer without omitempty.
const ALBY_GET_INFO_UNSET = {
  alias: null,
  color: null,
  pubkey: null,
  network: null,
  block_height: null,
  block_hash: null,
  methods: ['get_balance', 'pay_invoice', 'make_invoice'],
  notifications: [],
  lud16: null,
}

function walletReturning(result: unknown): FakeTransport {
  const transport = new FakeTransport()
  // Alby Hub marshals error as `json:"error,omitempty"` over a nil pointer, so
  // a successful response carries no error key at all.
  transport.responseFactory = () => ({ result, omitError: true })
  return transport
}

describe('shapes real wallet services put on the wire', () => {
  it('make_invoice accepts a pending invoice with empty preimage and null timestamps', async () => {
    const client = new NwcClient(VALID_URI, { transport: walletReturning(ALBY_PENDING_INVOICE) })
    try {
      const tx = await client.makeInvoice({ amount: 1000 })
      expect(tx.payment_hash).toBe('ab'.repeat(32))
      expect(tx.state).toBe('pending')
      expect(tx.amount).toBe(1000)
      expect(tx.fees_paid).toBe(0)
      // Emptiness must not survive into the result as a bogus value.
      expect(tx.preimage).toBeUndefined()
      expect(tx.description_hash).toBeUndefined()
      expect(tx.settled_at).toBeUndefined()
      expect(tx.expires_at).toBeUndefined()
    } finally {
      client.close()
    }
  })

  it('lookup_invoice accepts the same unsettled shape', async () => {
    const client = new NwcClient(VALID_URI, { transport: walletReturning(ALBY_PENDING_INVOICE) })
    try {
      const tx = await client.lookupInvoice({ payment_hash: 'ab'.repeat(32) })
      expect(tx.preimage).toBeUndefined()
      expect(tx.state).toBe('pending')
    } finally {
      client.close()
    }
  })

  it('list_transactions accepts a page mixing settled and pending entries', async () => {
    const settled = {
      ...ALBY_PENDING_INVOICE,
      state: 'settled',
      preimage: 'cd'.repeat(32),
      settled_at: 1786600100,
    }
    const client = new NwcTransactionHistoryClient(VALID_URI, {
      transport: walletReturning({ transactions: [ALBY_PENDING_INVOICE, settled] }),
    })
    try {
      const { transactions } = await client.listTransactions()
      expect(transactions).toHaveLength(2)
      expect(transactions[0]?.preimage).toBeUndefined()
      expect(transactions[1]?.preimage).toBe('cd'.repeat(32))
    } finally {
      client.close()
    }
  })

  it('accepts an outgoing keysend payment, which carries no invoice', async () => {
    const keysend = {
      type: 'outgoing',
      state: 'settled',
      invoice: '',
      description: '',
      description_hash: '',
      preimage: 'ef'.repeat(32),
      payment_hash: 'ab'.repeat(32),
      amount: 5000,
      fees_paid: 12,
      created_at: 1786600000,
      expires_at: null,
      settled_at: 1786600050,
    }
    const client = new NwcClient(VALID_URI, { transport: walletReturning(keysend) })
    try {
      const tx = await client.lookupInvoice({ payment_hash: 'ab'.repeat(32) })
      expect(tx.invoice).toBeUndefined()
      expect(tx.type).toBe('outgoing')
      expect(tx.preimage).toBe('ef'.repeat(32))
    } finally {
      client.close()
    }
  })

  it('get_info accepts a wallet whose optional fields are all null', async () => {
    const client = new NwcClient(VALID_URI, { transport: walletReturning(ALBY_GET_INFO_UNSET) })
    try {
      const info = await client.getInfo()
      expect(info.methods).toContain('pay_invoice')
      expect(info.alias).toBeUndefined()
      expect(info.pubkey).toBeUndefined()
      expect(info.block_height).toBeUndefined()
    } finally {
      client.close()
    }
  })

  it('refuses a timestamp that is plainly in milliseconds', async () => {
    // Coinos shipped millisecond timestamps here and it broke a client's date
    // parser. The value passes every other check, so without a range bound it
    // reaches application code as a date tens of thousands of years out.
    const client = new NwcClient(VALID_URI, {
      transport: walletReturning({ payment_hash: 'ab'.repeat(32), expires_at: 1_786_600_000_000 }),
    })
    try {
      await expect(client.makeInvoice({ amount: 1 }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally {
      client.close()
    }
  })

  it('accepts a plausible seconds timestamp at the boundary', async () => {
    const client = new NwcClient(VALID_URI, {
      transport: walletReturning({ payment_hash: 'ab'.repeat(32), expires_at: 4_102_444_800 }),
    })
    try {
      expect((await client.makeInvoice({ amount: 1 })).expires_at).toBe(4_102_444_800)
    } finally {
      client.close()
    }
  })

  it('still refuses a payment whose preimage is empty', async () => {
    // The phoenixd bridge observed in testing returned an empty preimage as a
    // successful result when its node could not route the payment. For
    // pay_invoice the preimage is the evidence of settlement, not an optional
    // detail, so emptiness there is a rejection rather than an absence.
    const client = new NwcClient(VALID_URI, { transport: walletReturning({ preimage: '' }) })
    try {
      await expect(client.payInvoice({ invoice: 'lnbc1' }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally {
      client.close()
    }
  })

  it('still refuses values that are present and wrong', async () => {
    for (const bad of [
      { preimage: 'not-hex-at-all' },
      { payment_hash: 'short' },
      { state: 'complete' },
      { type: 'sideways' },
      { amount: -1 },
    ]) {
      const client = new NwcClient(VALID_URI, { transport: walletReturning(bad) })
      await expect(client.makeInvoice({ amount: 1 }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      client.close()
    }
  })
})
