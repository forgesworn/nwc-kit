# nwc-kit

Small, security-focused Nostr Wallet Connect client for TypeScript.

**[Live demo and documentation](https://nwc-kit.forgesworn.dev)** — the
demo runs this library in the browser against a wallet that lives in the page,
so you can make that wallet forge a signature, replay an old response or confuse
a result type, and watch the client refuse it.

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
  `pure`, `pool` and `nip44` subpaths.
- MIT licensed.

Invoice and settlement verification belong in
[`farrier-kit`](https://github.com/forgesworn/farrier-kit). A payer should verify
the invoice before calling `payInvoice`, then verify the returned preimage
against the invoice payment hash before recording payment.

All NIP-47 amount, balance and fee fields are integers in **milli-satoshis**.
Convert sats explicitly at the application boundary and reject unsafe or
ambiguous amounts before making a wallet request.

Once publication begins, a timeout, abort, lost response or publication error is
an **unknown payment outcome**. A relay can store an event without returning a
usable acknowledgement. None of those local errors proves that the wallet
declined or failed to pay. Reconcile the original invoice before retrying; a
blind retry can pay twice.

## Usage

```ts
import { NwcClient } from '@forgesworn/nwc-kit'
import { tryDecodeBolt11, verifyPreimage } from 'farrier-kit'

declare function loadNwcUriFromPrivateStorage(): Promise<string>

// Retrieve this from app-owned private storage. Never hard-code or log it.
const connectionUri = await loadNwcUriFromPrivateStorage()
const client = new NwcClient(connectionUri)
const invoice = 'lnbc...'

try {
  const capabilities = await client.connect()
  if (!capabilities.methods.includes('pay_invoice')) {
    throw new Error('This connection cannot pay invoices')
  }

  const decoded = tryDecodeBolt11(invoice)
  if (!decoded || decoded.amountMsats === null) {
    throw new Error('Refusing an invalid or amountless invoice')
  }

  const result = await client.payInvoice({ invoice })
  if (!verifyPreimage(result.preimage, decoded.paymentHashHex)) {
    throw new Error('Wallet response does not settle this invoice')
  }
  console.log('Payment verified')
} finally {
  client.close()
}
```

`farrier-kit` in this example is an application dependency, not a dependency of
`nwc-kit`. Do not print or persist a returned preimage unless your protocol
requires it; for L402 it can become a bearer credential when combined with the
challenge macaroon.

Transaction history is optional NWC extension 05 and is isolated behind:

```ts
import { NwcTransactionHistoryClient } from '@forgesworn/nwc-kit/extensions/05'
```

That client always sends an explicit page `limit`, defaulting to 20 and capped
at 20. Extension 05 advises clients to page by at most 20, and a wallet asked
for no particular page size will apply a larger default of its own.

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

See `THREAT-MODEL.md`, `SECURITY.md` and `RELEASING.md` before integrating or
publishing changes.
