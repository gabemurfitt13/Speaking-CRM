# Existing Speaking CRM Gmail worker

There is one sender, `outreach-queue-worker`, and one server timer, `speaking-crm-existing-gmail-worker`. The timer invokes the existing `gmail_outreach_worker_tick()` every two minutes and requests at most two sends. ChatGPT automation `6ac6c49bdc248191a61b7bfef8348f52` only monitors/reconciles. It must never send directly or clear a pause automatically.

`gmail_worker_control.outreach_kind` chooses `initial` or `follow_up`. Follow-up mode parks initials and requires an explicit future `followups_authorized_until`. Expiry does not resume initials. Both modes use the existing serialized `live` requests, single-use request tokens, offline Gmail connection, quota pacing, shared 45 rolling-hour / 270 Boise-day ceilings, weekday 09–15 Boise and recipient hours, approval checks, active-claim protection and district spreading. No bypassing intentional holds or approval requirements.

For a coordinated read-only check when the timer is idle:

```sql
select public.request_gmail_outreach_worker('dry_run',2);
```

For an authorized manual execution, use the SAME existing request with `live`. This requires enabled control without a pause. PostgreSQL administration/service-role authorization is required. Results are in `gmail_worker_runs`; mode in the result identifies the actual follow-up or initial processor. No credentials or request tokens are returned. The existing function uses `verify_jwt=false` because its body authenticates single-use database-issued request tokens.

Approved follow-ups are selected only from ready rows without holds or the specific stale Oct15 Gmail quota-preflight hold. Other holds remain excluded. The worker rereads the verified contact, approved exact subject/body, complete exact-address all-mail history and all matching threads. It requires the explicit original SENT message, matching campus/recipient, RFC Message-ID, due date at least five business days later, no earlier exact-address reconnect, and no reply, OOO, bounce, draft or later send. Sibling district correspondence creates a review hold, never a claim that this campus replied. In Discussion is excluded.

The server reuses `js/threaded-followups.js` for analysis and MIME. Gmail POST includes the original `threadId`, `In-Reply-To` and `References`. The original subject is retained with `Re:`. A final fresh thread check and approval/control/prospect gate run before POST. Accepted IDs are preserved before confirmation. Only matching Gmail SENT/recipient/from/body/subject/original-thread/RFC reply headers can mark success. Original IDs remain unchanged; follow-up IDs/thread/date are stored separately and existing CRM sync triggers update the log and follow-up task. Ambiguous sends are held, never retried. More than two current-day delivery notices or provider restrictions pause the worker for review.

Existing confirmed initials retain their deterministic queue header and Gmail's actual RFC ID. Initial and follow-up copies are frozen while claimed. Expired claims become held for reconciliation, never automatically reopened. Preserved notes and approvals are not erased.

Sources: `db/gmail-worker.sql`, `db/gmail-worker-schedule.sql`, `db/gmail-worker-quota-cache.sql`, `db/gmail-threaded-worker.sql`. Tests: `node --test tests/*.test.cjs tests/*.test.mjs`. Transactional DB tests: `tests/gmail-worker-db.sql` and `tests/gmail-followup-worker-db.sql`, both rolled back. Database tests must not send email or commit QA provider IDs.

Deploy preserving repository paths: `supabase/functions/outreach-queue-worker/index.ts`, `worker.mjs`, `followups.mjs`, `supabase/functions/gmail-oauth/handler.mjs`, and `js/threaded-followups.js`. Never deploy only the entrypoint. Verify a dry run and an actual approved send in Gmail and CRM before claiming a deployment works.


Oct16 contact-source reconciliation: an old athletics-only note remains preserved. It can be superseded only by `progress.record.command.followupContactVerification` containing the exact unchanged approved email, a matching current `contact_source` URL on that email's school/district domain, `exactAddressPublished=true`, and a checkedAt timestamp no older than31 days. Other intentional holds still apply. Main confidence/date/source must also be current. This narrow check does not authorize a changed recipient, message, warm contact, replied school, or guessed address. Research-only updates never create approvals. A final fresh Gmail preflight and exact unchanged review remain mandatory. Covered by the102-test suite, including historical-source and unrelated-domain rejection cases.
