# Releasing nwc-kit

Releases use `forgesworn/anvil`: OIDC trusted publishing, provenance, exact-pack
secret scanning, export verification, runtime audit, pinned-action verification,
the locked protocol-vector test and two-runner reproducibility enforcement.
The reusable workflow itself is pinned to an audited commit, not a moving tag.

## First publish

npm requires the scoped package to exist before trusted publishing can be
configured. Do not bootstrap from a developer machine because local publication
cannot carry npm provenance. After the public GitHub repository exists and
`main` is green:

1. Create a short-lived granular npm token with only the publication access
   required for the ForgeSworn scope.
2. Create the protected GitHub environment `npm-bootstrap` and add that token as
   its `NPM_TOKEN` secret.
3. Run `bootstrap-release.yml`. It repeats the package gates on a GitHub-hosted
   runner, builds on a second independent runner, requires byte-identical
   tarballs, scans the exact pack set, and publishes the already-verified build
   A tarball with provenance. The token exists only in the protected publish
   job.
4. Verify the registry tarball, provenance, public repository and exact version.
5. Tag that verified commit as `v1.0.0` and push the tag.

Do not create a GitHub Release for `v1.0.0`; that would ask the release workflow
to publish the same version again.

Then configure the npm trusted publisher for repository `forgesworn/nwc-kit`,
workflow `release.yml`, environment `npm-publish`, with `npm publish` allowed.
Verify an OIDC patch release before disallowing tokens. Then revoke the bootstrap
token, remove `bootstrap-release.yml`, require 2FA and disallow token-based
publication.

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
