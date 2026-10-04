-- Recommendation-only orchestration queue. No external AI calls or automatic execution.
create table public.ai_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_kind text not null check (record_kind in ('progress','leads','website_inquiries')),
  record_id text not null,
  action_type text not null check (action_type in ('respond_inquiry','send_pricing','follow_up','proposal_follow_up','research_contact','confirm_event','collect_payment','collect_deposit','complete_contract','set_event_date','post_event_follow_up','restart_conversation')),
  title text not null,
  rationale text not null default '',
  priority smallint not null default 3 check (priority between 0 and 5),
  status text not null default 'pending' check (status in ('pending','approved','dismissed','executed','failed')),
  source text not null default 'rules' check (source in ('rules','ai')),
  source_key text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  unique(user_id, source_key)
);
alter table public.ai_actions enable row level security;
revoke all on table public.ai_actions from anon, authenticated;
grant select, insert, update on table public.ai_actions to authenticated;
grant all on table public.ai_actions to service_role;
create policy ai_actions_owner_read on public.ai_actions for select to authenticated using ((select auth.uid()) = user_id);
create policy ai_actions_owner_insert on public.ai_actions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy ai_actions_owner_update on public.ai_actions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create index ai_actions_owner_status_created on public.ai_actions(user_id,status,created_at desc);
create index ai_actions_record on public.ai_actions(user_id,record_kind,record_id);
create or replace function public.touch_ai_action_updated_at() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
revoke all on function public.touch_ai_action_updated_at() from public,anon;
create trigger ai_actions_touch before update on public.ai_actions for each row execute function public.touch_ai_action_updated_at();