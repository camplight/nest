# OrgOps upstream upgrade validation

Captured on 2026-10-21 against untouched OrgOps
`cc8faa01fd840f9d62912e33eacf861be7a6dfce`.

`validation.png` is a rendered report containing actual command-summary output,
not a screenshot of production or a new product screen. All integration/browser
checks use isolated fixtures; provider redirects and agent replies are simulated.
No live model or connected external account was used.

Passed: 166 Nest tests (including schema-038 upgrade preservation), workspace and
script type checks, both UI builds, six CLI tests, the production Docker build,
agent/model/assistant-request/mention browser suites, project/dashboard/chat,
onboarding, Google sign-in, Community, and the project connection-audience UI.

Upstream tests are **not fully green**. In separate disposable Node 22/Linux
containers, the previous `f7c95b7` pin passes 218/220 tests and `cc8faa0` passes
235/237. Both fail the same skill-directory ordering assertion and fixed-delay
shell-process-status assertion. No vendor test was patched or excluded. The
baseline container restores the old engine source while retaining the image's
installed dependencies; the lockfile update changes runtime dependency flags
for `tsx`, not package versions. macOS reproduces those two assertions; its file
upload tests also need a canonical temporary path (`TMPDIR=/private/tmp`).

Product fixtures explicitly disable the unused federation interval because the
new upstream poller outlives embedded database disposal. Engine tests retain
their normal settings. Production configuration is unchanged.
