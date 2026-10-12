-- Safe bulk INITIAL outreach groundwork. No email is sent by this migration.
-- Requires a separately deployed, authenticated Gmail worker before activation.
create table if not exists public.outreach_sender_control (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  initial_only boolean not null default true check (initial_only),
  daily_limit integer not null default 100 check (daily_limit between 1 and 270),
  batch_limit integer not null default 20 check (batch_limit between 1 and 45),
  updated_at timestamptz not null default now()
);
alter table public.outreach_sender_control enable row level security;
create policy "owner reads sender control" on public.outreach_sender_control
  for select to authenticated using (auth.uid() = user_id);
create policy "owner updates sender control" on public.outreach_sender_control
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner creates sender control" on public.outreach_sender_control
  for insert to authenticated with check (auth.uid() = user_id);
-- A worker must use an authenticated server-side identity, and atomically claim
-- only initial ready records; never use a browser-side Gmail token.
create or replace function public.claim_initial_outreach(p_user_id uuid, p_limit integer default 20)
returns setof public.outreach_queue
language plpgsql security invoker set search_path = ''
as $$
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'Unauthorized';
  end if;
  if not exists (
    select 1 from public.outreach_sender_control c
    where c.user_id = p_user_id and c.enabled and c.initial_only
  ) then return; end if;
  return query
  with selected as (
    select q.id
    from public.outreach_queue q
    join public.progress p on p.user_id=q.user_id and p.school_id=q.school_id
    where q.user_id=p_user_id and q.kind='initial' and q.status='ready'
      and p.status='Not Started' and coalesce(p.contacted,'')=''
      and lower(trim(p.email))=lower(trim(q.verified_email))
      and p.contact_confidence in ('high','verified')
      and p.last_verified is not null and p.contact_source is not null
      and q.approved_subject is not null and q.approved_body is not null
    order by q.created_at, q.id
    for update of q skip locked
    limit least(greatest(p_limit,1),45)
  )
  update public.outreach_queue q
  set status='sending',claimed_at=now(),updated_at=now(),attempt_count=coalesce(q.attempt_count,0)+1
  from selected s where q.id=s.id
  returning q.*;
end;
$$;
-- This claim function does not certify duplicate-free sending. The worker MUST
-- reconcile Gmail Sent, inbound replies, district caps, opt-outs, and quotas
-- before EACH send, then log provider IDs. Ambiguous sends must remain held.
