# Changelog

## 1.0.0 (2026-08-13)

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
