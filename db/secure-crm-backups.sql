-- Backups/reconciliation working tables are administrator/service-only.
-- Preserve every row and all administrator restore access.
do $$ declare t record;begin
 for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname ~ '^(progress(_record)?|outreach_queue)_backup_' or c.relname in ('recon_20261007_match','recon_20261007_sends')) loop
  execute format('alter table public.%I enable row level security',t.relname);
  execute format('revoke all on table public.%I from public,anon,authenticated',t.relname);
  execute format('grant all on table public.%I to service_role',t.relname);
 end loop;
end $$;
