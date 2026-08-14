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
- Once a payment request has been published, every failure is an ambiguous
  outcome: `RESPONSE_TIMEOUT`, `REQUEST_ABORTED`, `PUBLISH_FAILED`,
  `CLIENT_CLOSED` and `INVALID_RESPONSE` alike. A relay can store an event
  without returning a usable acknowledgement. Applications must reconcile the
  invoice before retrying and must never read any of these as proof of
  non-payment.
- `INVALID_RESPONSE` deserves specific attention, because it looks like a
  refusal and is not one. It means the wallet answered claiming a result that
  could not be trusted: a preimage that is not 32 bytes of hex, a mismatched
  `result_type`, an undecryptable payload. A wallet observed during testing
  returned an empty preimage as a successful result when its node could not
  route the payment. The library rejects such a response rather than reporting a
  settlement it cannot substantiate, but rejecting it is not the same as knowing
  the money stayed put.
- Only failures raised before publication are safe to treat as definitely not
  paid: `INVALID_CONNECTION`, `INVALID_REQUEST`, `UNSUPPORTED_METHOD`,
  `UNSUPPORTED_ENCRYPTION` and `INFO_UNAVAILABLE`.

Passing tests is not evidence that money settled. Production acceptance requires
a real wallet response and a preimage that hashes to the invoice payment hash.
