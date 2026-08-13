# Threat model

## Assets

- The NWC client secret and its wallet permissions.
- Wallet funds reachable through that connection.
- Payment truth: whether a specific invoice settled.
- Request and response confidentiality.

## Adversaries

- A malicious or compromised relay that injects, withholds, duplicates, replays
  or reorders events.
- An unrelated Nostr key attempting to forge a wallet response.
- A compromised merchant attempting to acquire a payer's NWC connection.
- Malformed wallet or relay payloads intended to exhaust memory or confuse
  result handling.
- An application retry that pays an invoice more than once.

## Security boundaries

The relay is untrusted. Event filters are performance hints, not authentication.
Every response is checked locally before decryption and use. Valid wallet events
that do not reference the active request are ignored as possible relay replays;
they cannot terminate that request.

The wallet service is authoritative for whether it attempted a payment, but its
response is not sufficient settlement proof. The consuming application must use
Farrier or equivalent verification to prove the preimage matches the invoice.

The application owns approval and spend policy. Wallet-enforced permissions and
budgets are mandatory defence in depth, not a replacement for application policy.

Publication is irreversible from this client's point of view. A relay can store
an event without returning a usable acknowledgement, and timeout, abort or local
close can happen after the wallet received the request. Once publication begins,
the application must treat any local failure as ambiguous, reconcile the
original invoice and avoid blind payment retries.

The connection URI enters as an immutable JavaScript string, so the library
cannot erase the caller's copy. It converts the secret into owned byte arrays
and zeroises those arrays on `close()`. Applications must protect persistent
configuration, logs, crash reports and process access themselves.

## Explicit non-goals

- Wallet-service or node implementation.
- Custody, balances or subwallet management.
- Forward secrecy or metadata hiding beyond NIP-44.
- BOLT-11, LNURL, L402, Cashu, WebLN or fiat functionality.
- Legacy NIP-04 interoperability.
