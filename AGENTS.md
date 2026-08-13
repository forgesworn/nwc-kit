# AGENTS.md — nwc-kit

Instructions for AI coding agents working on this repository.

## What This Project Is

A small, security-focused Nostr Wallet Connect client for TypeScript. It
implements the NIP-47 core and keeps draft extension 05 behind a separate
export. It lets an application spend through a constrained connection to
someone else's Lightning wallet.

It is **not** a wallet, wallet service, payment rail, custody layer, policy
engine or invoice verifier. Invoice decoding and preimage verification belong in
`farrier-kit`. Keep this package narrow — scope creep here is a security
problem, not just a design one.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run check` | Full gate: typecheck, import guard, coverage, build, bundle, pack, audit |
| `npm test` | Run all tests (vitest) |
| `npm run test:coverage` | Tests with coverage thresholds enforced |
| `npm run test:protocol` | The frozen NIP-44 vector test alone |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Bundle to dist/ with tsup |
| `npm run check:no-node-imports` | Fail if `node:` reaches browser-safe source |
| `npm run check:browser-bundle` | Prove both entry points bundle for the browser |
| `npm run check:pack` | Inspect the exact publish set |

## Project Structure

```
src/
  index.ts          — barrel re-export (main entry)
  client.ts         — NwcClient: discovery, request lifecycle, response authentication
  connection.ts     — NWC URI parsing, relay normalisation, conversation keys
  transport.ts      — NostrRelayTransport, the default SimplePool transport
  error.ts          — NwcError, control-character-safe wallet messages
  types.ts          — public types, the three NWC event kinds
  extensions/05.ts  — optional transaction history, separate export
test/
  helpers.ts        — FakeTransport, a wallet that signs real events
```

Two subpath exports: `@forgesworn/nwc-kit` and `@forgesworn/nwc-kit/extensions/05`.

## Conventions

- **British English** — normalise, serialise, behaviour
- **Milli-satoshis** — every NIP-47 amount, balance and fee. Convert at the application boundary
- **NIP-44 v2 only** — legacy NIP-04 is refused, not merely deprecated
- **ESM-only**, no `node:` imports in `src/` — the source must run in a browser
- **One runtime dependency** (`nostr-tools`, pinned exactly). A second needs a written reason
- **Adversarial tests** for security-sensitive changes; a happy-path test is not enough
- Never commit a real NWC connection string or a live wallet fixture

## Rules That Are Easy To Break

**The relay is untrusted.** Subscription filters are performance hints, not
authentication. Every response is shape-checked, signature-verified, and matched
to the active request before anything is decrypted or returned. A valid wallet
event that does not reference the live request is a possible relay replay and
must be ignored rather than allowed to fail the request.

**Local failure is not proof of non-payment.** Timeout, abort, close and publish
failure are all ambiguous once publication has begun. Never phrase them, in code
or docs, as though the payment did not happen.

**Test against real wallets, not just the NIP text.** Wallets diverge from the
spec's prose. Two divergences are load-bearing here and have regression tests:

- A successful response may omit `error` entirely rather than setting it to
  null — Alby Hub marshals it `json:"error,omitempty"` over a nil pointer.
- `list_transactions` must always send an explicit `limit`, because wallets
  apply their own default otherwise. Alby Hub's is 50, above the 20 the
  extension advises clients to page by.

Before tightening any response validation, check a real implementation. The
test suite's `FakeTransport` is only as honest as the shapes it is told to send.

**Bounds are deliberate.** Every length, count and timeout limit in `client.ts`
exists to stop a hostile wallet or relay exhausting the caller. Raise one only
with a reason.

**The info-event requirement is stricter than the spec on purpose.** NIP-47 makes
the kind 13194 info event a SHOULD. This client treats it as mandatory, because a
wallet advertising no encryption mode defaults to NIP-04 under the spec, and this
client does not implement NIP-04. Wallets that skip the info event fail with
`INFO_UNAVAILABLE`. Do not relax this to "assume NIP-44 when the info event is
missing" — that guesses about the encryption of a spending capability.

## Testing against a real wallet

`scripts/real-wallet-smoke.mjs` points the built bundle at a live wallet service.
It reads the connection string from an owner-only file, never argv or the
environment, and runs read-only methods unless `--pay` is passed:

```bash
npm run build
node scripts/real-wallet-smoke.mjs /path/to/nwc-uri.txt
```

Use it before any release that touches connection parsing, capability discovery
or response handling. The fake wallet in `test/` and this client were written by
the same hand, so agreement between them is weaker evidence than it looks.
