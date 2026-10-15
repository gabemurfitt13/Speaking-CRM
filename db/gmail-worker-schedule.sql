-- One server timer for the EXISTING worker. The existing ChatGPT task becomes monitor-only.
create extension if not exists pg_cron;
create or replace function public.gmail_outreach_worker_tick()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare u uuid; localnow timestamp:=now() at time zone 'America/Boise'; ctl public.gmail_worker_control%rowtype;
begin
 if current_user<>'postgres' and coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service role required';end if;
 if extract(isodow from localnow)>5 or localnow::time<time '09:00' or localnow::time>=time '15:00' then return jsonb_build_object('skipped','outside Boise hours');end if;
 select user_id into u from public.gmail_connections where mailbox='gabemurfittspeaker@gmail.com' and status='connected';
 if u is null then return jsonb_build_object('skipped','Gmail authorization unavailable');end if;
 select * into ctl from public.gmail_worker_control where user_id=u;
 if not found or not ctl.enabled or ctl.pause_reason is not null then return jsonb_build_object('skipped','worker disabled or paused');end if;
 if exists(select 1 from public.gmail_worker_runs where user_id=u and ((status='requested' and expires_at>now()) or (status='running' and started_at>now()-interval '15 minutes'))) then return jsonb_build_object('skipped','worker already active');end if;
 -- Expiry creates a hold for reconciliation, never reopens or retries the draft.
 perform public.expire_unconfirmed_outreach_claims(u);
 return public.request_gmail_outreach_worker('live',2);
end; $$;
revoke all on function public.gmail_outreach_worker_tick() from public,anon,authenticated;
grant execute on function public.gmail_outreach_worker_tick() to service_role;
-- Scheduling is activated separately only after the worker live-send verification.
