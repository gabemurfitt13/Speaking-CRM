# Existing Speaking CRM worker: Gmail initials

The existing worker uses the authorized offline Gmail connection. One server timer invokes the SAME existing worker; the existing ChatGPT automation is monitor-only, so there is no competing sender. Only unchanged, approved, ready direct-school initials are sent. Follow-ups, replies and non-schools are excluded.

The server timer named `speaking-crm-existing-gmail-worker` invokes `gmail_outreach_worker_tick()` every two minutes, requesting at most two sends per run. The existing ChatGPT task `6ac6c49bdc248191a61b7bfef8348f52` monitors and reconciles only. For a coordinated manual run when the timer is idle:

```sql
select public.request_gmail_outreach_worker('live',45);
```

For read-only checks use modes `dry_run` or `audit_claims`. Results are in `public.gmail_worker_runs`. Requesting a run requires PostgreSQL administration/service role. A short-lived, single-use random token authenticates the HTTP request, so deploy the existing worker with `verify_jwt=false`; authentication is implemented in its body. No Gmail/Supabase credentials are returned to callers.

The worker enforces weekdays 09–15 Boise and recipient local time, 45 rolling-hour/270 Boise-day account outbounds, district spreading, current approval, contact verification, intentional holds and named special cases. All Gmail search pages include Spam/Trash. Complete SENT counts refresh before each claim. Full district threads are inspected or skipped for review. Another queue/AI claim blocks sending. More than two delivery notices today or provider restrictions pause live execution.

Approval/copy is conditionally claimed and frozen in flight. Intent is saved before sending. Deterministic RFC Message-ID supports recovery; no automatic send retry occurs. Gmail acceptance IDs are saved, then SENT/To/From/subject/body/RFC ID must all match before CRM success. Failed rejections and ambiguous sends are distinct and held. Confirmed IDs/threads/date/status/log are synchronized, preserving notes. Prepared follow-ups remain held.

A run has a maximum of 45 sends and a 95-second loop budget. It can return fewer for caps, history, holds, or runtime. Continue only through the SAME serialized worker; never a competing sender. No automatic unpause after provider failures.

SQL: `db/gmail-worker.sql`. Tests: `node --test tests/*.test.cjs tests/gmail-oauth.test.mjs tests/gmail-worker.test.mjs`. Transactional database checks: `tests/gmail-worker-db.sql` followed by ROLLBACK. Never commit QA sent identifiers.

Deploy files preserving directories: `outreach-queue-worker/index.ts`, `outreach-queue-worker/worker.mjs`, `gmail-oauth/handler.mjs`. The shared module handles encryption and existing credential name variants. Control defaults disabled. Audit connection/claims, dry run, enable under Gabe's authorization, test one eligible live send and verify Gmail/CRM before reconnecting the main automation as a monitor.

Server schedule source: `db/gmail-worker-schedule.sql` and `db/activate-existing-gmail-worker.sql`. There is exactly one timer job with that name. SQL serialization prevents overlap. Worker control `enabled=false` stops future live runs; `pause_reason` also suppresses them. Business hours are evaluated in Boise inside the tick, so the UTC cron expression handles DST without changing the job.
