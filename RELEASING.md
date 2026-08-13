# Releasing nwc-kit

Releases use `forgesworn/anvil`: OIDC trusted publishing, provenance, exact-pack
secret scanning, export verification, runtime audit, pinned-action verification,
the locked protocol-vector test and two-runner reproducibility enforcement.
The reusable workflow itself is pinned to an audited commit, not a moving tag.

## First publish

A trusted publisher cannot be configured for a package that does not yet exist:
npm's package settings page is the only place to set one, and there is no
settings page until something has been published. See
[npm/cli#8544](https://github.com/npm/cli/issues/8544). The first version
therefore goes up by hand, exactly as anvil documents, and every release after
it goes through OIDC.

No npm token is involved at any point. Use an interactive session for the one
manual publish and OIDC for everything else.

With the public repository in place and `main` green:

1. `npm login` and confirm with `npm whoami`.
2. `npm run check` locally. This is the same sequence CI runs.
3. `npm publish --access public --no-provenance`.

   `--no-provenance` is required. `publishConfig.provenance` is `true` and must
   stay `true`, because anvil refuses to publish without it, but provenance can
   only be attested from a supported CI runner. A workstation publish that tries
   to attest fails.
4. Confirm the published tarball, then tag that commit as `v0.1.0` and push the
   tag. Do not create a GitHub Release for it; that would ask the release
   workflow to publish the same version a second time.
5. On npmjs.com, configure the trusted publisher for the now-existing package:
   repository `forgesworn/nwc-kit`, workflow `release.yml`, environment
   `npm-publish`. Create that environment in GitHub if you want a branch or
   reviewer gate on it.
6. Verify one OIDC patch release end to end, then require 2FA and disallow
   token-based publishing for the package.

`0.1.0` is the only version that will lack a provenance attestation. That is the
cost of npm's bootstrap gap, and it is at its cheapest on a first `0.x` release.

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
