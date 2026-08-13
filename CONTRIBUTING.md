# Contributing

Keep this package narrow. It owns NIP-47 wallet communication, not wallet
custody, merchant protocols, payment policy, BOLT-11 decoding or settlement
verification.

Use Node 22 or 24, then run:

```bash
npm ci
npm run prepublishOnly
npm audit
```

Security-sensitive changes need adversarial tests. New runtime dependencies need
a written reason and must pass the runtime audit. Use British English and do not
put secrets, real NWC connection strings or live wallet fixtures in tests.

Report vulnerabilities through a private GitHub security advisory, as described
in `SECURITY.md`.

