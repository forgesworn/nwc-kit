# Releasing nwc-kit

Releases use `forgesworn/anvil`: OIDC trusted publishing, provenance, exact-pack
secret scanning, export verification, runtime audit, pinned-action verification,
the locked protocol-vector test and two-runner reproducibility enforcement.
The reusable workflow itself is pinned to an audited commit, not a moving tag.

## Trusted publisher

Every release is published by the release workflow over OIDC; there is no
manual publish step and no npm token. The npm trusted publisher for
`@forgesworn/nwc-kit` is:

- repository `forgesworn/nwc-kit`
- workflow `release.yml`
- environment `npm-publish` (anvil's default publish environment)

If a release fails with `E404` on publish, the trusted publisher is missing or
no longer matches these three values.

`publishConfig.provenance` must stay `true`: anvil refuses to publish without
it.

`0.1.0` has no provenance attestation. npm cannot attach a trusted publisher to
a package that does not exist yet
([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so that one version
was published before OIDC was configured. Every version from `0.1.1` on carries
provenance.

## The site

`npm run build:site` compiles `site/` into `docs/`, which is committed and
verified by CI. The published site at <https://nwc-kit.forgesworn.dev> is those
files served statically from `/opt/nwc-kit-site` behind Caddy, which terminates
TLS and sets the security headers, including the `frame-ancestors` directive
that a meta-tag policy cannot carry. Rebuild, commit, then copy `docs/` to the
host; there is no deployment hook, on purpose.

## Later releases

1. Bump `package.json` and `package-lock.json`.
2. Add the changelog entry.
3. Merge the green change to `main`.
4. Create the GitHub Release for the matching `vX.Y.Z` tag.

The release workflow publishes only after every anvil gate succeeds.
