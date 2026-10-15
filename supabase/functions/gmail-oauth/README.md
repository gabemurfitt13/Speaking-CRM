# Speaking CRM offline Gmail connection

This function establishes authorization only. It never sends messages, claims outreach rows, or creates schedules. The existing sender remains the only sender until an independently tested worker upgrade.

## Deployment

Apply `db/gmail-offline-connection.sql`. Deploy `gmail-oauth` with `verify_jwt = false`: Google callbacks cannot carry a Supabase JWT. All start/status operations explicitly verify the owner via Supabase Auth. The callback validates an expiring, atomic, single-use state and PKCE. Health exposes only configuration booleans.

Required secrets: `GOOGLE_CLIENT_ID` (the existing Speaking CRM client), `GOOGLE_CLIENT_SECRET`. Supabase supplies its URL, anon key, and service-role key. Register this exact Google redirect:

`https://hoyilsqwbdkbxismiatf.supabase.co/functions/v1/gmail-oauth/callback`

Open `/Speaking-CRM/gmail-connect.html` in the browser where the CRM is signed in, then authorize the speaking mailbox. A wrong mailbox cannot replace a connection. An OAuth consent screen in Testing may issue refresh tokens lasting only seven days; confirm publishing status before calling this permanent.

## Security and operation

Tokens are AES-GCM encrypted using an HKDF-derived service-role key and mailbox-bound authenticated data. Tables have RLS, no anon/authenticated grants or policies, and service-role-only access. Refresh tokens never reach the browser. Rotating the Supabase service-role key requires reconnecting Gmail. Do not disable the previous Google secret while other integrations may use it.

Callback and provider errors do not echo codes/tokens or provider response bodies. No access tokens or raw request URLs are logged. Status indicates authorization was saved, not a fresh refresh-token verification or sending-worker health check.

Run `node --test tests/gmail-oauth.test.mjs`. Before enabling worker use, test refresh, full mailbox duplicate checks, caps/district holds, ambiguous outcomes, CRM synchronization, and scheduled execution. The current function does not assert those checks have passed.
