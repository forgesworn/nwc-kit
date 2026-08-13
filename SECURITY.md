# Security

Please report vulnerabilities privately through the GitHub security advisory
form for the repository. Do not open a public issue for an unpatched wallet,
cryptographic, secret-handling or relay-authentication vulnerability.

## Supported posture

- NIP-44 v2 only.
- Signed wallet information and response events are mandatory.
- Wallet author, request reference, client recipient and result method are all
  checked before a result is trusted.
- NWC connection strings are spending capabilities. The library never logs or
  returns them.
- JavaScript strings are immutable and cannot be reliably zeroised. The caller
  owns the original URI string and its storage. `close()` cancels pending work
  and zeroises the library-owned secret and conversation-key byte arrays.
- Applications remain responsible for amount policy, user approval, wallet-side
  budgets, BOLT-11 verification and preimage verification.
- Once publication begins, timeout, abort, connection-close and publication
  errors are local outcomes. A relay can store an event without returning a
  usable acknowledgement. Applications must reconcile the invoice before
  retrying and must never interpret cancellation or publication failure as
  proof of non-payment.

Passing tests is not evidence that money settled. Production acceptance requires
a real wallet response and a preimage that hashes to the invoice payment hash.
