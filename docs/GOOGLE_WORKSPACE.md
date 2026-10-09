# Google Workspace sign-in

Nest can admit colleagues from one Google Workspace domain. Share the Nest URL;
each colleague chooses **Continue with Google** and an account is created on their
first verified sign-in. They join the configured default team. No invitation email,
Directory API import or temporary password is required.

OrgOps owns these identities, team memberships, authentication settings and
sessions. Nest supplies the login/admin UI and forwards the engine endpoints through
its normal HTTP adapter. Nest's product database does not store Google identities
or credentials.

## Set up Google

1. Create a Google Cloud project inside your Workspace organization.
2. In **Google Auth Platform**, configure branding and an **Internal** audience.
3. Create a **Web application** OAuth client. Register the exact redirect URI:
   `https://YOUR_NEST_HOST/api/auth/google/callback`.
4. Put these values in the private server environment:

   ```dotenv
   NEST_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID
   NEST_GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET
   NEST_GOOGLE_REDIRECT_URI=https://YOUR_NEST_HOST/api/auth/google/callback
   ```

   Never use a `VITE_*` variable for a secret or commit credentials. The Compose
   deployment loads its private `.env`; recreate the container to apply changes.
   With an external engine, configure the corresponding `ORGOPS_GOOGLE_*` variables
   on that engine instead. The Nest launcher translates `NEST_*` for bundled engines.
5. Sign into Nest administration as the instance owner. Open **Sign-in**, enter
   the allowed Workspace domain and default team, enable Google sign-in and save.
6. Verify sign-in in a fresh browser session, then share the workspace URL.

Only `openid`, `email` and `profile` are requested. Google API access, Directory
synchronization and sending invitations are not part of this setup. The callback
must use HTTPS outside localhost. Keep the existing local owner login for recovery.

## Account and session behavior

- Both the verified hosted-domain claim and email domain must match exactly.
  A personal Google account with a similar email is insufficient.
- The stable Google subject identifies an account across later email changes.
  A conflicting existing local username is rejected; accounts are not silently linked.
- Google-created accounts cannot use local password sign-in, including passwords
  supplied through the existing reset API. Existing local accounts still work.
- Existing OrgOps resource permissions apply. Team membership does not grant access
  to another human's private Nest projects or private Community publishing tokens.
- Google sessions expire after eight hours and on server restart. Saving sign-in
  settings revokes existing Google sessions and pending login flows. WebSocket
  traffic rechecks sessions before delivery; idle sockets close on their next activity.
- Workspace suspension is checked through a fresh Google login, not synchronized
  continuously. An already-issued Nest session may remain valid until expiry or
  revocation. No Google refresh tokens are stored.

The instance owner is the earliest human by creation time, with ID as the tie-breaker.
Other humans and runner credentials cannot manage Google sign-in settings.

## Troubleshooting

A missing Google button means sign-in is disabled or server configuration is
incomplete. The owner screen shows credential presence, never the secret itself.
`redirect_uri_mismatch` means the callback in Google and the server differ.
Expired state requires restarting sign-in in the same browser. Restarting the
server or saving sign-in settings also invalidates an in-progress flow.

The implementation uses authorization-code exchange, PKCE, nonce and a five-minute
single-use state bound to an HttpOnly browser cookie. Google's SDK validates the
ID token's signature, issuer, audience and expiry. Nest preserves both callback
cookies and translates only the engine session cookie to `nest_session`.

## Verification

`npm test` exercises the real Nest/OrgOps boundary with Google's SDK responses
simulated. `npm run test:ui:auth` exercises both login UIs, owner settings,
desktop/mobile layouts, OAuth redirects and automatic account creation against
isolated databases. It does not prove a live Google login; test that separately
with the deployed OAuth client.
