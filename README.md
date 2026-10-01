# Speaking CRM

## Dependable outreach update (draft)

The nullable JSONB record column was applied to the CLEAR CRM database on
September 6, 2026. All 107 existing rows remained. Rollback-only SQL checks under
the authenticated role verified owner save/read access and unrelated-user read
isolation. The existing legacy contact-detail columns are preserved on read/write.

### Deployment order

1. In the existing app, export a full backup on every device with recent edits.
   The former cloud writer did not confirm saves, and some fields were omitted.
2. Verify the target is the Speaking CRM Supabase project, confirm the existing
   `progress` schema and owner-based RLS policies, and back up the database.
3. Apply `db/prepare-record-storage.sql` after that review. It adds a nullable
   JSONB `record` column without changing existing columns or permissions.
4. Deploy this branch only after the column is ready. Missing schema or denied
   writes now show a persistent failure message rather than a false success.
5. Sign in and import the most current exported backup. Imports replace matching
   IDs and retain other schools. Review conflicts between device backups rather
   than blindly importing an older copy last. The old browser cache is retained;
   **Export Pre-update Backup** retrieves it if no pre-deployment export was made.
6. Verify **Saved to cloud**, sign out/in, and check a custom school, edited
   contact verification fields, additional contacts, and cleared fields. Repeat
   on a second device. Test with a disposable record before using real outreach.

## Behavior

Complete school records are persisted alongside legacy columns. Only changed
records are written, in batches. Pending edits are stored per authenticated user,
retained on failure, and retried online or with Retry Cloud Save. Cloud reads are
paginated and a failed read does not replace local pending work. Sign-out is
blocked on failed sync, and leaving with pending changes prompts the browser.
The legacy shared browser cache is never automatically assigned to an account.

Email drafts are editable, require a send confirmation, and reject common link
placeholders. No automated outreach is introduced. Switching schools remounts
the detail panel so finance and contact fields cannot carry over. Hot leads means
In Discussion; previous hosts remain available through the existing filter.
Payments Received is separate from Recorded Fees.

## Validation

Run `node --test tests/*.test.cjs`.

Eight automated regression tests pass. Database-level authenticated round-trip
and unrelated-user read-isolation checks passed without retaining test changes.
The full browser sign-in/save/reload flow remains a deployment gate: the cloud
browser could not open the local preview. SQL checks do not replace UI checks.
Simultaneous editing of the same school on multiple devices is still last-write
wins; finish syncing one device before editing that school on another. An API
send success does not establish inbox delivery. Draft text is not persisted.
## Speaking Command Center (October 2026)

The default home screen is now a practical Command Center. Existing school records,
cloud synchronization, Gmail sending, backups, status values, and the Website
Inquiries inbox remain in place. Mobile navigation collapses into a Menu button.

### Data model and migration order

Apply all three `supabase/migrations/*command*.sql` migrations in timestamp order before
shipping the frontend. They were applied to project `hoyilsqwbdkbxismiatf` on
October 1, 2026. They add nullable-compatible metadata (JSONB `command`) to existing
leads/inquiries and append-only owner-protected `crm_activity` history. School
opportunity metadata reuses `progress.record.command`; no duplicate prospect table
is introduced. All triggers are security invoker with an empty search path. New
history permits authenticated owner SELECT/INSERT only. Existing policies remain.

Inquiry metadata uses a column-specific UPDATE grant under the existing owner RLS.
Future status transitions, explicit milestones and new activity logs are captured
at the database, including writes by existing integrations. Repeated identical
log entries are deduplicated by owner/record/content hash. Existing records are
not backfilled with invented creation, reply, proposal or booking dates.

### Metrics

* Calendar dates and Monday-start weeks use America/Boise.
* Booked revenue YTD and booking count use `command.bookedOn` or a captured booking
  transition. Event date is separate and powers the next 90 days of booked fees.
* Revenue is speaking fees, not receipts or reimbursements. Blank financial values
  remain unknown. Open pipeline value is unweighted known fee/potential fee for
  active contacted opportunities; untouched directory prospects are excluded.
* Weekly first/follow-up contacts use confirmed sent Email logs, ordered by date.
  New Gmail sends explicitly mark first versus follow-up. Queued, failed, bounced,
  scheduled and draft entries are excluded. Email logging proves sending, not the
  quality of personalization. Partner calls/meetings also count as partner contacts.
* Qualification requires explicit confirmation and a qualification date. Loading
  bundled school seeds does not count as business-development work.
* Sales conversations, pricing requests and proposals use explicit logs or newly
  captured milestone/status changes. A later stage does not imply prior-stage
  evidence. Funnel percentages use the intersection of recorded evidence sets,
  so incomplete history cannot silently manufacture conversions.
* Pipeline/funnel period filters select records created or active within that
  period; they are not historical point-in-time pipeline snapshots. Top financial
  cards retain their labeled YTD/90-day windows. Weekly execution retains its week.
* Inquiry source uses existing traffic metadata. Unknown source remains unknown.
  Existing integration-test inquiries are excluded. An inquiry can be explicitly
  linked to an existing prospect to exclude it from aggregate prospect totals;
  it remains in Website Inquiries, and the retained prospect needs its own source.
* Relationships link generated opportunities by stable record key. Influenced
  revenue is attributed relationship reporting, not extra revenue.

### Operating the first version

Use **Add Prospect** for conferences, churches, businesses and relationships.
Use **Details** in the Command Center to classify an existing prospect, mark
qualification, add CFP dates, pricing/proposal stage, source, booking date, fee,
contract/deposit/payment/travel information, originating partner, and post-event
assets. Existing CRM status remains authoritative for bookings and closed leads.
Log Reply, Sales conversation, Pricing request, or Proposal sent in the existing
activity log when those events actually happen. Log content only after publishing.
A successful email send continues through the original confirmed Gmail flow.

This first version tracks one current engagement per prospect record, matching the
existing CRM. It is not an accounting system or a multi-engagement ledger. Amount
received is the total received, including deposit; deposit received is a workflow
flag. Historical editing on multiple devices remains last-write wins as before.

### Verification

`node --test tests/*.test.cjs`: 19 passing tests (including existing persistence and
inquiry regression coverage). Browser checks render the real App with isolated
in-memory development fixtures at 1440px and 390px; cover menu navigation,
opportunity details, market drilldown and Website Inquiries, with no JavaScript
errors or horizontal page overflow. No development fixture is sent to Supabase.

Production read-only records reconcile to 17 first contacts + 39 follow-ups for
week beginning September 28, and 13 due follow-ups on October 1. Production
transaction tests verify owner-trigger history, no-op deduplication and unrelated
user isolation; all test changes were rolled back. Post-migration record counts:
267 progress, 0 leads, 1 existing closed test inquiry, 0 retained test history.
Supabase security advisor reports no new table/RLS issues; the pre-existing auth
warning for disabled leaked-password protection remains.

Advisor reference: existing [leaked-password protection warning](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
and legacy progress/leads [RLS performance warnings](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan)
remain outside this change. New activity policies use cached auth.uid() lookups.

### Publication status

The user explicitly authorized uploading the implementation to
`gabemurfitt13/Speaking-CRM` and opening a pull request on October 1, 2026.
The changes are prepared on `codex/speaking-command-center`. All three additive
database migrations are applied. The production frontend remains unchanged until
the pull request is merged and the existing hosting deployment completes.
