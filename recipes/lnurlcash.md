# Recipe: LNURLcash bearer notes over NWC

[LNURLcash](https://github.com/dni/lnurl-mint) is a bearer-note scheme built
on plain LUD-03/LUD-06: a mint's node holds the sats, and whoever knows a
note's secret owns its value. The reference wallet
([lnurl-wallet](https://github.com/dni/lnurl-wallet)) is a serverless browser
SPA, which makes NWC the natural wallet layer: NIP-47 is outbound-only from
the client, so the SPA stays serverless, and every LNURLcash amount is already
in milli-satoshis.

Two flows touch a Lightning wallet. Both are automated below with `nwc-kit`.

## Minting a note

Paying the mint's invoice reveals a preimage, and that preimage **is** the
bearer secret. A wrong preimage is a worthless note, which is why
`payInvoice` refusing any preimage that is not 64-char hex matters here.

```ts
import { NwcClient } from '@forgesworn/nwc-kit'
import { tryDecodeBolt11, verifyPreimage } from 'farrier-kit'

const client = new NwcClient(connectionUri)
await client.connect()

// 1. LUD-06 payRequest, then its callback with the amount (msat)
const pay = await fetch(`${mint}/p`).then(r => r.json())
const { pr } = await fetch(`${pay.callback}?amount=${amountMsat}`).then(r => r.json())

// 2. Verify the invoice asks for what you expect before paying it.
// LNURLcash mints may withhold a fee from the note's value (advertised in
// the payRequest metadata); the invoice amount is what you pay, not what
// the note is worth. amountMsats is a bigint.
const decoded = tryDecodeBolt11(pr)
if (!decoded) throw new Error('undecodable invoice')
if (decoded.amountMsats !== BigInt(amountMsat)) throw new Error('amount mismatch')

// 3. Pay. The preimage in the result is the note's spend secret, so prove it
// hashes to the invoice's payment hash: a mint that answered with the wrong
// preimage would have handed you a worthless note.
const { preimage } = await client.payInvoice({ invoice: pr })
if (!verifyPreimage(preimage, decoded.paymentHashHex)) throw new Error('preimage mismatch')

// 4. The mint's node saw this preimage first, so it is a permanent prior
// holder of the note: import the secret into your note store and rotate it
// immediately, spending it into a fresh note whose secret only you have seen.
```

## Melting a note

Redeeming a note back to sats means handing the mint an invoice to pay.
`makeInvoice` produces it; `lookupInvoice` polls settlement, tolerating
wallets that send empty preimages on unsettled invoices (Alby Hub does).

```ts
// 1. Invoice for the note's value net of the mint fee, in msat
const inv = await client.makeInvoice({
  amount: noteValueMsat,
  description: `melt ${mintHost}`,
})

// 2. LUD-03 withdraw callback: k1 is the note secret, pr the invoice
const res = await fetch(
  `${mint}/w/cb?k1=${secret}&pr=${inv.invoice}`,
).then(r => r.json())
if (res.status !== 'OK') throw new Error(res.reason)

// 3. The mint pays asynchronously; poll your own wallet for settlement
for (;;) {
  const tx = await client.lookupInvoice({ payment_hash: inv.payment_hash })
  if (tx.state === 'settled') break
  if (tx.state === 'expired' || tx.state === 'failed') throw new Error(tx.state)
  await new Promise(r => setTimeout(r, 2_000))
}
// Only now mark the note spent in your store.
```

## Notes

- Amounts are milli-satoshis on both sides; there is no conversion boundary.
- A mint is a counterparty, not a verifier: check invoice amounts before
  paying and preimages after, exactly as with any other NWC payment.
- The NIP-47 `notifications` extension would replace the settlement poll
  with push over the same outbound relay subscription; until then
  `lookupInvoice` polling is sufficient.
- A live (experimental) mint for testing: `https://mint.forgesworn.dev` —
  small notes only, the LNURLcash spec is still a draft.
