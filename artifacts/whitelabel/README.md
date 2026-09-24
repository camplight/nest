# Instance branding verification

Reusable white-label settings live in the main Nest product source, with Camplight
values kept in `deploy/camplight-branding.json`. Screenshots show local production
builds with mocked API data, except `live-*.png`, which show the deployed sign-in
and branding settings. No production conversations are included.

`smoke.mjs` covers both apps' branded sign-in, desktop/mobile layouts, dark theme
persistence, channel filtering/message submission, admin navigation, saving
branding, and loading the saved identity after refresh. Set `NEST_PLAYWRIGHT` to
a Playwright module path and optionally `NEST_CHROMIUM` to a compatible browser.
Run after `npm run build`.

Focused API tests cover default branding before login, owner-only writes,
rejection of runner/other-human writes, persistence across app recreation,
restoring defaults, input validation and payload limits. Both UI builds and all
workspace TypeScript checks pass.

Live verification passed for Camplight sign-in, loaded logo assets, the owner's
branding editor, the purple workspace sidebar, the Nest footer, and absence of
browser errors. The temporary browser session was logged out afterward.
