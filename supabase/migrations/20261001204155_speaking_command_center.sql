-- Additive only: no backfill, record replacement or status changes.
alter table public.website_inquiries add column if not exists command jsonb not null default '{}'::jsonb;
alter table public.leads add column if not exists command jsonb not null default '{}'::jsonb;
create table public.crm_activity (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 record_kind text not null check(record_kind in ('progress','leads','website_inquiries','content')),
 record_id text not null, event_type text not null, occurred_at timestamptz not null default now(),
 event_key text not null default gen_random_uuid()::text, details jsonb not null default '{}'::jsonb,
 unique(user_id,record_kind,record_id,event_key)
);
alter table public.crm_activity enable row level security;
create policy activity_owner_read on public.crm_activity for select to authenticated using ((select auth.uid())=user_id);
create policy activity_owner_insert on public.crm_activity for insert to authenticated with check ((select auth.uid())=user_id);
grant select,insert on public.crm_activity to authenticated;
grant all on public.crm_activity to service_role;
create index crm_activity_owner_time on public.crm_activity(user_id,occurred_at desc,id);
create index progress_owner on public.progress(user_id);
create index inquiries_owner_followup on public.website_inquiries(user_id,follow_up);
create or replace function public.capture_crm_activity() returns trigger language plpgsql security invoker set search_path='' as $$
declare n jsonb:=to_jsonb(new); o jsonb:='{}'; rid text; entry jsonb; oldlogs jsonb; oldcmd jsonb; cmd jsonb;
begin
 if tg_op='UPDATE' then o:=to_jsonb(old); end if;
 rid:=coalesce(n->>'school_id',n->>'id');
 cmd:=case when tg_table_name='progress' then coalesce(n->'record'->'command','{}') else coalesce(n->'command','{}') end;
 oldcmd:=case when tg_table_name='progress' then coalesce(o->'record'->'command','{}') else coalesce(o->'command','{}') end;
 if tg_op='INSERT' then
  insert into public.crm_activity(user_id,record_kind,record_id,event_type,details) values(new.user_id,tg_table_name,rid,'created',jsonb_build_object('market',cmd->>'market'));
 end if;
 if n->>'status' is distinct from o->>'status' then
  insert into public.crm_activity(user_id,record_kind,record_id,event_type,details) values(new.user_id,tg_table_name,rid,'status',jsonb_build_object('from',o->>'status','to',n->>'status','fee',n->>'fee','command',cmd));
 end if;
 if cmd->>'stage' is distinct from oldcmd->>'stage' or cmd->>'qualified' is distinct from oldcmd->>'qualified' then
  insert into public.crm_activity(user_id,record_kind,record_id,event_type,details) values(new.user_id,tg_table_name,rid,'milestone',jsonb_build_object('stage',cmd->>'stage','qualified',cmd->>'qualified'));
 end if;
 oldlogs:=coalesce(o->'log','[]');
 for entry in select value from jsonb_array_elements(coalesce(n->'log','[]')) loop
  if not oldlogs @> jsonb_build_array(entry) then
   insert into public.crm_activity(user_id,record_kind,record_id,event_type,event_key,details)
    values(new.user_id,tg_table_name,rid,'log','log:'||md5(entry::text),entry) on conflict do nothing;
  end if;
 end loop;
 return new;
end $$;
revoke all on function public.capture_crm_activity() from public,anon;
create trigger command_progress_history after insert or update on public.progress for each row execute function public.capture_crm_activity();
create trigger command_leads_history after insert or update on public.leads for each row execute function public.capture_crm_activity();
create trigger command_inquiry_history after insert or update on public.website_inquiries for each row execute function public.capture_crm_activity();
