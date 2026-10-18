# nwc-kit

Small, security-focused Nostr Wallet Connect client for TypeScript.

**[Live demo and documentation](https://nwc-kit.forgesworn.dev)**: the
demo runs this library in the browser against a wallet that lives in the page,
so you can make that wallet forge a signature, replay an old response or confuse
a result type, and watch the client refuse it.

This is an early `0.x` release. The client is verified against the NIP-44
protocol vectors, an adversarial fake wallet, and a controlled mainnet
acceptance through Rizful in the 402-mcp payment path. That proves one wallet
and provider path, not every real-world implementation, so the API may still
move. Pin an exact version.

It implements the current [draft NIP-47 core](https://github.com/nostr-protocol/nips/blob/master/47.md)
and keeps [draft extension 05](https://github.com/nostr-wallet-connect/nwc/blob/main/05.md)
behind a separate export. Protocol drafts can evolve; package releases follow
semantic versioning and do not silently broaden the supported surface.

`nwc-kit` lets an application use a constrained connection to an existing
Lightning wallet. It is not a wallet, wallet service, payment rail, custody
layer, policy engine, or invoice verifier.

## Properties

- NIP-47 core client operations only.
- NIP-44 v2 required. Legacy NIP-04 is deliberately refused.
- Multiple relays, signed capability discovery and authenticated responses.
- Request expiry, bounded inputs, timeouts, abort signals and deterministic cleanup.
- Browser, Node 22+, Deno and Bun compatible source with no `node:` imports.
- ESM-only package exports. CommonJS consumers must use dynamic `import()`.
- One direct runtime dependency: `nostr-tools`, imported through focused
  `pure`, `pool` and `nip44` subpaths, plus the type-only `core` and `filter`
  subpaths.
- MIT licensed.

Invoice and settlement verification belong in
[`farrier-kit`](https://farrier-kit.forgesworn.dev). A payer should verify
the invoice before calling `payInvoice`, then verify the returned preimage
against the invoice payment hash before recording payment.

All NIP-47 amount, balance and fee fields are integers in **milli-satoshis**.
Convert sats explicitly at the application boundary and reject unsafe or
ambiguous amounts before making a wallet request.

Once a `payInvoice` request has been published, **every** failure is an unknown
payment outcome unless the wallet explicitly refused it (see `WALLET_ERROR`
below). That includes `RESPONSE_TIMEOUT`, `REQUEST_ABORTED`,
`PUBLISH_FAILED`, `CLIENT_CLOSED` and, importantly, `INVALID_RESPONSE`.

`INVALID_RESPONSE` is the one that surprises people. It means the wallet replied
claiming a result, and the result was unusable: a preimage that is not 32 bytes
of hex, a mismatched `result_type`, an undecryptable payload. A wallet that
answers with a broken success is not telling you the payment failed. It is
telling you nothing you can rely on. This is not hypothetical: a real bridge
observed during testing returned an empty preimage as a *successful* result when
its node could not route the payment.

`WALLET_ERROR` means the wallet sent a signed, authenticated error, and its own
code is in `error.walletCode`. Only an explicit refusal is definite:
`PAYMENT_FAILED`, `INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED`, `RATE_LIMITED`,
`RESTRICTED`, `UNAUTHORIZED` or `NOT_IMPLEMENTED`. `INTERNAL` and `OTHER` are
ambiguous: the wallet hit a problem, not necessarily before it attempted the
payment. Treat any code outside that list the same way, including a missing one,
which the library reports as `OTHER`. Reconcile before retrying.

Apart from an explicit refusal, only failures raised **before** publication are
safe to treat as definitely not paid: `INVALID_CONNECTION`, `INVALID_REQUEST`, `UNSUPPORTED_METHOD`,
`UNSUPPORTED_ENCRYPTION`, `UNSUPPORTED_EXTENSION` and `INFO_UNAVAILABLE`. Those
never reach the wallet.

A relay can also store an event without returning a usable acknowledgement, so
even `PUBLISH_FAILED` does not prove the wallet never saw the request. Reconcile
the original invoice before retrying; a blind retry can pay twice.

## Usage

```bash
npm install @forgesworn/nwc-kit farrier-kit
```

`farrier-kit` is the invoice and preimage verifier used in the example below.
It is an application dependency, not a dependency of `nwc-kit`.

```ts
import { NwcClient, NwcError } from '@forgesworn/nwc-kit'
import { tryDecodeBolt11, verifyPreimage } from 'farrier-kit'

declare function loadNwcUriFromPrivateStorage(): Promise<string>

// Raised before the request is published: nothing reached the wallet.
const NOT_SENT = new Set([
  'INVALID_CONNECTION', 'INVALID_REQUEST', 'UNSUPPORTED_METHOD',
  'UNSUPPORTED_ENCRYPTION', 'UNSUPPORTED_EXTENSION', 'INFO_UNAVAILABLE',
])
// A signed, explicit refusal by the wallet.
const REFUSED = new Set([
  'PAYMENT_FAILED', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED',
  'RATE_LIMITED', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED',
])

function classify(error: NwcError): 'not-sent' | 'refused' | 'ambiguous' {
  if (NOT_SENT.has(error.code)) return 'not-sent'
  if (error.code === 'WALLET_ERROR' && REFUSED.has(error.walletCode ?? '')) return 'refused'
  // Timeout, abort, publish failure, close, INVALID_RESPONSE, and WALLET_ERROR
  // with INTERNAL, OTHER or any other code: the payment may have happened.
  return 'ambiguous'
}

// Retrieve this from app-owned private storage. Never hard-code or log it.
const connectionUri = await loadNwcUriFromPrivateStorage()
const client = new NwcClient(connectionUri)
const invoice = 'lnbc...'
let payRequested = false

try {
  const capabilities = await client.connect()
  if (!capabilities.methods.includes('pay_invoice')) {
    throw new Error('This connection cannot pay invoices')
  }

  const decoded = tryDecodeBolt11(invoice)
  if (!decoded || decoded.amountMsats === null) {
    throw new Error('Refusing an invalid or amountless invoice')
  }

  payRequested = true
  const result = await client.payInvoice({ invoice })
  if (!verifyPreimage(result.preimage, decoded.paymentHashHex)) {
    // The wallet claimed success, so this is not evidence of non-payment.
    throw new Error('Wallet response does not settle this invoice')
  }
  console.log('Payment verified')
} catch (error) {
  if (!(error instanceof NwcError)) throw error
  // Before payInvoice is called, nothing can have been paid.
  const outcome = payRequested ? classify(error) : 'not-sent'
  console.error(`Payment ${outcome}: ${error.code} ${error.walletCode ?? ''}`)
  // 'ambiguous': reconcile with the wallet before any retry. A blind retry can pay twice.
} finally {
  client.close()
}
```

Do not print or persist a returned preimage unless your protocol requires it;
for L402 it can become a bearer credential when combined with the challenge
macaroon.

`connect()` is optional before a request. Every request method, including
`payInvoice`, calls it implicitly when the client holds no capabilities yet, so
the first call pays for one extra discovery query. Calling it first lets you
read `capabilities.methods` before spending, and keeps discovery failures
(`INFO_UNAVAILABLE`, `UNSUPPORTED_ENCRYPTION`) apart from request failures.
Discovery is read-only: an error from `connect()`, `INVALID_RESPONSE` for a
malformed info event included, always precedes any request, which is why the
example above treats everything before `payInvoice` as not sent. A successful
result is cached for the life of the client and `connect()` can be called
again to refresh it. `close()` discards it, after which every call throws
`CLIENT_CLOSED`.

The `amount` field of `payInvoice` is milli-satoshis, for amountless invoices
only. The client forwards it unchecked and does not decode the invoice, so it
cannot tell whether an invoice already carries an amount. The example refuses
amountless invoices as its own policy, because it wants the amount verified
before paying; that is not a restriction of the library.

Transaction history is optional NWC extension 05 and is isolated behind:

```ts
import { NwcTransactionHistoryClient } from '@forgesworn/nwc-kit/extensions/05'
```

That client always sends an explicit page `limit`, defaulting to 20. A `limit`
above 20 is rejected with `INVALID_REQUEST`, not clamped, and a response with
more transactions than the requested `limit` is rejected as `INVALID_RESPONSE`.
Extension 05 advises clients to page by at most 20, and a wallet asked for no
particular page size will apply a larger default of its own.

## Recipes

- [LNURLcash bearer notes over NWC](recipes/lnurlcash.md): minting and melting
  LNURLcash notes through an NWC wallet connection, checked against a live
  (experimental) mint.

## Wallet compatibility

This client refuses to send anything until it has read a **signed kind 13194
info event** from the wallet, advertising `nip44_v2` in its `encryption` tag.

NIP-47 makes that event a SHOULD rather than a MUST, so this is stricter than
the specification requires, and deliberately. A wallet that publishes no info
event advertises no encryption mode, and the specification's default for that
case is legacy NIP-04, which this library does not implement. Guessing that an
undiscoverable wallet happens to support NIP-44 v2 is not a guess worth making
with a spending capability.

The practical consequence: a minimal or homegrown NIP-47 bridge that skips the
info event will fail here with `INFO_UNAVAILABLE`, even where it works with more
permissive clients. That is the wallet to fix, not this client. Publishing a
replaceable kind 13194 event whose content lists the supported methods, tagged
`["encryption", "nip44_v2"]`, is all that is required.

### Known wallet behaviour

Only Rizful has been tested live. The others were surveyed by reading what each
wallet's service code actually puts on the wire, rather than what the
specification says it should, and are expected to work but have not been run
against.

| Wallet | Status | Note |
| --- | --- | --- |
| Rizful | Tested (mainnet) | Controlled acceptance through the 402-mcp payment path |
| Alby Hub | Expected (code survey) | Unset fields arrive as `""` and `null`; handled since 0.1.4 |
| Coinos | Expected (code survey) | Advertises `nip44_v2`, omits `error` on success |
| Zeus | Expected (code survey) | Via `@getalby/sdk` |
| LNbits `nwcprovider` | Not yet | NIP-04 only today. [PR #51](https://github.com/lnbits/nwcprovider/pull/51) adds NIP-44 v2 and would make it work |

No surveyed wallet publishes an `extensions` tag, so a method named in the
capability list is accepted as the wallet's declaration of it. That is the
wallet's own explicit statement rather than an assumption, and every request
method refuses any method missing from that list regardless, with
`UNSUPPORTED_METHOD`.

`payInvoice` refuses an empty preimage, and that refusal is an ambiguous outcome
rather than a failure. Zeus returns exactly that shape deliberately, to mean an
HTLC is in flight but not yet settled, so an application reading it as "the
payment did not happen" will be wrong precisely when the payment is still on its
way. Reconcile the invoice.

## Runtime contract

The default transport uses the runtime's global `WebSocket`. Node 22+, current
browsers, Deno and Bun provide it. Tests and specialised runtimes can inject an
`NwcTransport` implementation.

Treat the NWC URI like a spending-capability password. Never log it, send it to
a merchant, put it in a URL query string, or reuse one connection across apps.
On servers, prefer a secret manager or an owner-only regular file referenced by
path; do not put the URI itself in an environment variable. Validate file type,
size and permissions before reading it. In browsers, persist it only after an
explicit user choice and only in app-owned private storage.
JavaScript strings cannot be reliably erased: the caller still owns the URI
string and any persistent copy. `close()` cancels in-flight requests and
zeroises the library-owned secret and conversation-key byte arrays.

## Security and release gates

The CI matrix runs on Node 22 and 24. It enforces type safety, adversarial and
protocol-vector tests, coverage thresholds, browser bundling, package inspection
and a full dependency audit. Releases add exact-pack secret scanning, export
verification, provenance and two-runner reproducibility through ForgeSworn
Anvil.

See `THREAT-MODEL.md` and `SECURITY.md` before integrating, and
[`RELEASING.md`](https://github.com/forgesworn/nwc-kit/blob/main/RELEASING.md)
in the repository before publishing changes.

## Support

For issues and feature requests, see [GitHub Issues](https://github.com/forgesworn/nwc-kit/issues).

If nwc-kit is useful to you, a tip is always welcome:

- Lightning: `profusemeat89@walletofsatoshi.com`
- Nostr zaps: `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

## Licence

[MIT](LICENSE)
