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

## Restricted presentation namespaces

Nested presentations can use `/demo/<namespace>/<slug>` with files stored in a
**separate private root**, by default a `restricted-demos` sibling of the ordinary
demo root. `NEST_RESTRICTED_DEMO_ROOT` overrides it. Never place that root inside
the ordinary demos directory or a public UI directory. Older application releases
cannot serve this separate root; rollback therefore does not publish its contents.

Create `<restricted-root>/<namespace>/.access.json` with this schema:

```json
{"version":1,"allowedHumanIds":["explicit-authorized-human-id"]}
```

Use stable IDs from the authoritative human directory after the owner identifies
the intended audience. A username suffix is not verified organization membership.
Every request revalidates the human session and reads this policy. Missing,
malformed, empty, oversized and unreadable policies deny access. Password setup
must be completed. Namespace, policy and asset symlinks are rejected. Restricted
namespaces are omitted from `/api/artifacts`, including ordinary-demo collisions.

A presentation lives at `<namespace>/<slug>/index.html`. Extensionless, trailing
slash, `.html`, direct `index.html`, and relative asset URLs share the policy.
Existing demo proxy and login return handling already cover these nested URLs.
No Caddy modification is needed. Do not copy restricted content into ordinary
`demos` or invoke the standard publisher: it is for all-human demo access only.

### Safe installation and rollout

1. Deploy the reviewed application release before installing confidential files.
2. Verify with a synthetic namespace and synthetic content that an allowed human
   receives the exact bytes while an excluded signed-in human receives 404.
   Anonymous 401 alone does not prove the new audience gate is installed.
3. Stage the complete namespace (policy and self-contained presentation) in a
   private sibling directory outside BOTH served roots. Use an explicit owner-
   approved ID list; never grant all users as a temporary installation step.
4. Atomically rename the staged directory into the private root. For updates,
   write a temporary policy/index in its containing directory and rename over the
   destination; keep backups outside all served roots. Do not remove the policy
   to grant access: absence fails closed. Deny filesystem write access to viewers.
5. Verify installed bytes and signed-in allowed/denied access across aliases and
   assets, anonymous denial, policy-file denial, logout/revocation, login return,
   and private/no-store headers. Do not acquire another person's session; use
   operator-owned test accounts or report authenticated verification outstanding.

To revoke access, atomically replace the policy with an empty ID list or remove
that namespace's policy. To unpublish, move the namespace outside the served
root. Existing browser documents cannot be remotely erased after download.
