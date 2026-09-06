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
