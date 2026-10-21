# Authenticated demos

Nest serves `/demo/*` through its API and validates the existing human session
using OrgOps HTTP on every request. Anonymous, invalid and revoked sessions get
302 to the existing Nest login for HTML browser requests, preserving the demo return destination through password/Google sign-in. Non-HTML requests retain 401. Runner credentials do not grant viewing access. All
responses disable caching. After sign-in, the browser returns to the original demo URL, including query parameters and fragment. Only local `/demo/` return destinations are accepted.

Files remain in `.nest-data/demos` (`NEST_DEMO_ROOT` overrides the API path).
The publisher still atomically writes `slug/index.html`; extensionless, trailing
slash and `.html` links remain supported. Assets under the slug require the same
session. Hidden files, traversal and symlinks outside the demo root are denied.
Vite development and preview middleware forwards demo requests to the API before
static serving, even if an older controller recreates static symlinks. The
container passes its internal API port to that middleware.

## Rollout prerequisites

The old host controller requires an anonymous Kibrit HTTP 200/body hash and would
roll back this release. An operator must install the reviewed
`deploy/devops/nest-ops.py` on the host before deploying this change. Repository
updates do not install the host controller. The new check requires anonymous 401 for protected images and retains byte-hash
verification for legacy images, including rollback. It detects the capability
from the running image, not the source checkout.
The revised controller creates static demo symlinks only for legacy images.

Install `deploy/demos/publish.mjs` over the persistent
`nest-publish-demo/scripts/publish.mjs` helper for every publishing runtime.
It supports both old public hosting (exact HTTP body hash) and authenticated
hosting (local installed hash plus anonymous 401/no-store). It explicitly reports
that authenticated browser verification is still required; it does not acquire
or accept a human session or add a viewing bypass. Existing publication and
backup paths and arguments are unchanged. The skill's previous claim of public
byte verification applies only to legacy public hosting.

After deployment, check all existing slugs anonymously, log in with an authorized
test account and open each demo and its assets, then log out and verify access is
revoked. No engine pin, database migration or engine runtime credential change is
required. No live human credentials are used in repository tests.
