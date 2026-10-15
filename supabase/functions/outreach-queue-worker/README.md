# Existing Speaking CRM worker: Gmail initials

The existing worker uses the authorized offline Gmail connection. No new sender or cron job is created. Only unchanged, approved, ready direct-school initials are sent. Follow-ups, replies and non-schools are excluded.

The sole main automation `6ac6c49bdc248191a61b7bfef8348f52` invokes:

```sql
select public.request_gmail_outreach_worker('live',45);
```

For read-only checks use modes `dry_run` or `audit_claims`. Results are in `public.gmail_worker_runs`. Requesting a run requires PostgreSQL administration/service role. A short-lived, single-use random token authenticates the HTTP request, so deploy the existing worker with `verify_jwt=false`; authentication is implemented in its body. No Gmail/Supabase credentials are returned to callers.

The worker enforces weekdays 09–15 Boise and recipient local time, 45 rolling-hour/270 Boise-day account outbounds, district spreading, current approval, contact verification, intentional holds and named special cases. All Gmail search pages include Spam/Trash. Complete SENT counts refresh before each claim. Full district threads are inspected or skipped for review. Another queue/AI claim blocks sending. More than two delivery notices today or provider restrictions pause live execution.

Approval/copy is conditionally claimed and frozen in flight. Intent is saved before sending. Deterministic RFC Message-ID supports recovery; no automatic send retry occurs. Gmail acceptance IDs are saved, then SENT/To/From/subject/body/RFC ID must all match before CRM success. Failed rejections and ambiguous sends are distinct and held. Confirmed IDs/threads/date/status/log are synchronized, preserving notes. Prepared follow-ups remain held.

A run has a maximum of 45 sends and a 95-second loop budget. It can return fewer for caps, history, holds, or runtime. Continue only through the SAME serialized worker; never a competing sender. No automatic unpause after provider failures.

SQL: `db/gmail-worker.sql`. Tests: `node --test tests/*.test.cjs tests/gmail-oauth.test.mjs tests/gmail-worker.test.mjs`. Transactional database checks: `tests/gmail-worker-db.sql` followed by ROLLBACK. Never commit QA sent identifiers.

Deploy files preserving directories: `outreach-queue-worker/index.ts`, `outreach-queue-worker/worker.mjs`, `gmail-oauth/handler.mjs`. The shared module handles encryption and existing credential name variants. Control defaults disabled. Audit connection/claims, dry run, enable under Gabe's authorization, test one eligible live send and verify Gmail/CRM before reconnecting the main automation.
