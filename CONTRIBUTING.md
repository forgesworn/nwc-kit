# Contributing

Keep this package narrow. It owns NIP-47 wallet communication, not wallet
custody, merchant protocols, payment policy, BOLT-11 decoding or settlement
verification.

Use Node 22 or 24, then run:

```bash
npm ci
npm run check
```

`npm run check` runs the same sequence CI does: type safety, the browser-import
guard, coverage thresholds, the build, browser bundling, package inspection and
the dependency audit.

Security-sensitive changes need adversarial tests. New runtime dependencies need
a written reason and must pass the runtime audit. Use British English and do not
put secrets, real NWC connection strings or live wallet fixtures in tests.

Wallets diverge from the specification's prose, so check response handling
against a real wallet implementation before tightening it. The test suite's fake
wallet is only as honest as the shapes it is told to send, and a gate that no
real wallet can pass is worse than no gate.

Report vulnerabilities through a private GitHub security advisory, as described
in `SECURITY.md`.

