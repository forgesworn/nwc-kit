# Changelog

## 0.1.5 (2026-08-14)

### Fixed

- Transaction timestamps outside the Unix-seconds range are now refused.
  `created_at`, `expires_at` and `settled_at` in milliseconds are perfectly good
  positive integers, so they passed every existing check and reached application
  code as dates roughly forty thousand years out. Coinos shipped this by
  accident and it broke a client's date parser. Anything past the year 2100 is
  rejected. Amounts and fees are unaffected, being milli-satoshis rather than
  timestamps.

### Documented

- A survey of what shipping wallets put on the wire, taken from their service
  code rather than from the specification. Alby Hub, Coinos and Zeus work.
  LNbits `nwcprovider` is **incompatible**: it is NIP-04 only and publishes no
  `encryption` tag, so discovery fails before anything is sent. Zeus reaches the
  wire through `@getalby/sdk`, which publishes no `extensions` tag, so extension
  05 is unavailable there even though `list_transactions` is implemented.

- Zeus returns a successful `pay_invoice` result with an empty preimage on
  purpose, to mean an HTLC is in flight but not yet settled. This client refuses
  that response rather than reporting a settlement it cannot substantiate, and
  the refusal is an ambiguous outcome rather than a failure: an application that
  reads it as "the payment did not happen" will be wrong precisely when the
  payment is still on its way.

## 0.1.4 (2026-08-14)

### Fixed

- Transaction and wallet-info results no longer reject `""` and `null` in
  optional fields. Go marshals an unset string as `""` and a nil pointer as
  `null` unless the struct tag says `omitempty`, and Alby Hub's NIP-47 structs
  mostly do not carry it. Its ordinary responses therefore arrive full of empty
  strings and nulls where a literal reading of the specification expects the
  field to be missing.

  The effect was severe. `makeInvoice()` failed **every** time against Alby Hub,
  because a freshly created invoice has no preimage and the empty string was
  read as a malformed one. `lookupInvoice()` failed on anything unsettled,
  `listTransactions()` failed on any page containing a pending entry, and
  `getInfo()` failed whenever a single optional field, such as an unset node
  alias or colour, came back null.

  Emptiness is now recognised as absence wherever a field is optional. Values
  that are present and wrong are still refused, and `payInvoice()` still demands
  a real preimage: there it is the evidence of settlement rather than an
  optional detail, so an empty one remains a rejection.

- An empty `invoice` is treated as absence rather than corruption, because an
  outgoing keysend payment has no invoice to report.

### Added

- `test/wallet-shapes.test.ts`, fixtures taken from what shipping wallets put on
  the wire rather than from what the specification's prose describes.

## 0.1.3 (2026-08-14)

### Documented

- `INVALID_RESPONSE` on a published payment is an **ambiguous outcome**, not a
  refusal. The previous wording listed timeout, abort, close and publication
  failure as the ambiguous cases, which invited the reading that a rejected
  response meant the money had definitely stayed put. It does not.

  A wallet that answers with an unusable result has not said the payment failed;
  it has said nothing that can be acted on. Found against a real wallet: a bridge
  returned an empty preimage as a *successful* result whenever its node could not
  route the payment, because the node signalled failure with an HTTP 200 body
  rather than an error status. This client rejects such a response instead of
  reporting a settlement it cannot substantiate, but rejection is a statement
  about the evidence, not about the money.

  `README.md`, `SECURITY.md`, `THREAT-MODEL.md` and `llms.txt` now enumerate
  which error codes are ambiguous after publication, and which are raised before
  publication and therefore prove that nothing was attempted.

No runtime or API change.

## 0.1.2 (2026-08-13)

### Fixed

- Capability discovery now retries when a relay answers with nothing. Measured
  against a live wallet on a single relay, `connect()` succeeded on the first
  query 4 times in 8; with retries, 7 in 8. The first call a consumer makes was
  failing up to half the time.

  Discovery is a read, so repeating it cannot cost anything. That is the
  opposite of a payment, and the distinction is why retrying is safe here and
  never safe for a request. Only a fast empty answer is retried: a relay that
  consumed its whole timeout is unresponsive rather than empty, and is left
  alone. Retries run inside the existing `infoTimeoutMs`, so the worst case a
  caller waits is unchanged.

  Multiple relays remain the real answer to a relay that goes quiet, and that is
  the connection string's job rather than this client's.

## 0.1.1 (2026-08-13)

### Changed

- Prepare the first release through npm trusted publishing with provenance.
  The public API and runtime behaviour are unchanged from `0.1.0`.

### Documented

- Wallet compatibility: this client requires a signed kind 13194 info event
  advertising `nip44_v2` before it will send anything. NIP-47 makes that event a
  SHOULD, so this is stricter than the specification, and deliberately: a wallet
  advertising no encryption mode defaults to NIP-04 under the specification, and
  NIP-04 is not implemented here. A wallet that skips the info event fails with
  `INFO_UNAVAILABLE`.

## 0.1.0 (2026-08-13)

First release. The API is not yet frozen: this client has been verified against
the NIP-44 protocol vectors and an adversarial fake wallet, but not yet against
a real wallet service in the field. Expect the 0.x line to move while that
happens. See the wire-compatibility notes in `AGENTS.md`.

### Added

- NIP-47 client with NIP-44 v2 encryption and authenticated wallet events.
- Strict connection URI parsing, bounded relay inputs and secret-safe inspection.
- Signed capability discovery and core pay, invoice, lookup and balance methods.
- Optional NIP-47 extension 05 transaction history behind a separate export,
  always requesting an explicit page of at most 20 transactions so a wallet
  cannot apply a larger default of its own.
- Timeout, abort, relay-acceptance and deterministic cleanup controls.
- Browser-safe ESM output for Node 22+, browsers, Deno and Bun.

### Security

- Reject legacy NIP-04, unsigned responses, wrong authors, duplicate or wrong
  request references, oversized content and method-confused responses.
- Ignore valid wallet events replayed by a relay when they do not reference the
  active request; relay-side subscription filters are not trusted.
- Snapshot caller metadata, bound event tags and normalise hostile transport
  input before it reaches protocol parsing.
- Treat timeout, abort and local close as ambiguous payment outcomes that must
  be reconciled before retry.
- Close the abort-listener registration race so a signal that flips during setup
  cannot publish a cancelled request.
- Require consuming applications to verify invoices and returned preimages before
  recording payment.
