# CLAUDE.md — nwc-kit

Nostr Wallet Connect (NIP-47) client. Talks to someone else's Lightning wallet
over a constrained connection. Not a wallet, not an invoice verifier.

## Commands

- `npm run check` — the full gate: typecheck, import guard, coverage, build, bundle, pack, audit
- `npm test` — run all tests (vitest)
- `npm run test:coverage` — tests with v8 coverage and thresholds
- `npm run test:protocol` — the frozen NIP-44 vector test alone
- `npm run typecheck` — type-check without emitting
- `npm run build` — bundle to dist/ with tsup
- `npm run check:no-node-imports` — fail if `node:` reaches browser-safe source
- `npm run check:browser-bundle` — prove both entry points bundle for the browser
- `npm run check:pack` — inspect the exact publish set

## Dependencies

One runtime dependency: `nostr-tools`, pinned exactly, imported through the
`pure`, `pool`, `nip44`, `core` and `filter` subpaths only. Adding a second
runtime dependency needs a written reason — see `CONTRIBUTING.md`.

## Structure

- `src/connection.ts` — NWC URI parsing, relay normalisation, conversation-key derivation
- `src/client.ts` — `NwcClient`: capability discovery, request/response lifecycle, response authentication
- `src/transport.ts` — `NostrRelayTransport`, the default `SimplePool` transport
- `src/error.ts` — `NwcError` and control-character-safe wallet messages
- `src/types.ts` — public types and the three NWC event kinds
- `src/extensions/05.ts` — optional transaction history, separate export

## Conventions

- **British English** — normalise, serialise, behaviour
- **Milli-satoshis** — every NIP-47 amount, balance and fee field. Convert at the application boundary
- **NIP-44 v2 only** — legacy NIP-04 is refused, not merely deprecated
- **ESM-only**, no `node:` imports in `src/` — the source must run in a browser
- **Adversarial tests** for anything security-sensitive; a happy-path test is not enough
- Never put a real NWC connection string or live wallet fixture in a test

## Wire-compatibility traps

Real wallets do not always send what the spec's prose says. Two cases are load-
bearing and are covered by regression tests:

- A successful response may **omit** the `error` key entirely rather than setting
  it to null. Alby Hub marshals it as `json:"error,omitempty"` over a nil
  pointer. Absent and null both mean success.
- `list_transactions` must always send an explicit `limit`. Wallets apply their
  own default when it is absent — Alby Hub's is 50, above the 20 the extension
  advises clients to page by.

Before changing response validation, check the behaviour against a real wallet
implementation, not just the NIP text.
