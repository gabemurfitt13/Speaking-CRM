-- Upgrade the existing outreach-queue-worker. No new sender or schedule is created.
create extension if not exists pg_net;
create table public.gmail_worker_control (
 user_id uuid primary key references auth.users(id), enabled boolean not null default false,
 pause_reason text, updated_at timestamptz not null default now()
);
create table public.gmail_worker_runs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 mode text not null check(mode in ('dry_run','live','audit_claims')), max_sends int not null check(max_sends between 1 and 45),
 status text not null default 'requested' check(status in ('requested','running','completed','failed','abandoned')),
 token_hash text, expires_at timestamptz not null default now()+interval '2 minutes',
 requested_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 request_id bigint, result jsonb
);
create unique index gmail_worker_one_active_run on public.gmail_worker_runs(user_id) where status in ('requested','running');
alter table public.gmail_worker_control enable row level security;
alter table public.gmail_worker_runs enable row level security;
revoke all on public.gmail_worker_control,public.gmail_worker_runs from public,anon,authenticated;
grant select,insert,update,delete on public.gmail_worker_control,public.gmail_worker_runs to service_role;

create or replace function public.request_gmail_outreach_worker(p_mode text default 'dry_run',p_max_sends int default 1)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare owner_id uuid; run_id uuid; token text; net_request_id bigint; ctl public.gmail_worker_control%rowtype;
begin
 if current_user<>'postgres' and coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service role required';end if;
 if p_mode not in ('dry_run','live','audit_claims') or p_max_sends not between 1 and 45 then raise exception 'Invalid worker mode or limit';end if;
 select user_id into owner_id from public.gmail_connections where mailbox='gabemurfittspeaker@gmail.com' and status='connected';
 if owner_id is null then raise exception 'Authorized speaking Gmail connection required';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text,0));
 insert into public.gmail_worker_control(user_id) values(owner_id) on conflict do nothing;
 select * into ctl from public.gmail_worker_control where user_id=owner_id;
 if p_mode='live' and (not ctl.enabled or ctl.pause_reason is not null) then raise exception 'Worker disabled or paused: %',coalesce(ctl.pause_reason,'not enabled');end if;
 update public.gmail_worker_runs set status='abandoned',finished_at=now(),token_hash=null,result=jsonb_build_object('error','Worker lease expired; reconcile any sending claims before retry') where user_id=owner_id and ((status='requested' and expires_at<now()) or (status='running' and started_at<now()-interval '15 minutes'));
 if exists(select 1 from public.gmail_worker_runs where user_id=owner_id and status in ('requested','running')) then raise exception 'Another worker run is active';end if;
 token:=gen_random_uuid()::text||gen_random_uuid()::text;
 insert into public.gmail_worker_runs(user_id,mode,max_sends,token_hash) values(owner_id,p_mode,p_max_sends,encode(sha256(convert_to(token,'UTF8')),'hex')) returning id into run_id;
 select net.http_post(url:='https://hoyilsqwbdkbxismiatf.supabase.co/functions/v1/outreach-queue-worker',body:=jsonb_build_object('runId',run_id,'runToken',token),headers:=jsonb_build_object('Content-Type','application/json'),timeout_milliseconds:=120000) into net_request_id;
 update public.gmail_worker_runs set request_id=net_request_id where id=run_id;
 return jsonb_build_object('runId',run_id,'requestId',net_request_id,'mode',p_mode,'maxSends',p_max_sends);
end; $$;
revoke all on function public.request_gmail_outreach_worker(text,int) from public,anon,authenticated;
grant execute on function public.request_gmail_outreach_worker(text,int) to service_role;

create or replace function public.claim_gmail_worker_request(p_run_id uuid,p_token text)
returns setof public.gmail_worker_runs language sql security invoker set search_path='' as $$
 update public.gmail_worker_runs set status='running',started_at=now(),token_hash=null
 where id=p_run_id and status='requested' and expires_at>now() and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') returning *;
$$;
revoke all on function public.claim_gmail_worker_request(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_gmail_worker_request(uuid,text) to service_role;

create or replace function public.gmail_worker_candidates(p_user_id uuid,p_limit int default 200,p_offset int default 0)
returns setof jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('queue',to_jsonb(q),'prospect',to_jsonb(p))
 from public.outreach_queue q join public.progress p using(user_id,school_id)
 where q.user_id=p_user_id and q.kind='initial' and q.status='ready' and q.review_approved_at is not null
 and q.school_id !~ '^(biz-|church-|college-|conf-)' and nullif(trim(q.hold_reason),'') is null
 and (q.scheduled_at is null or q.scheduled_at<=now()) and p.status='Not Started'
 order by q.created_at desc,q.id limit least(greatest(p_limit,1),300) offset greatest(p_offset,0);
$$;
revoke all on function public.gmail_worker_candidates(uuid,int,int) from public,anon,authenticated;
grant execute on function public.gmail_worker_candidates(uuid,int,int) to service_role;

create or replace function public.claim_gmail_initial(p_run_id uuid,p_queue_id uuid,p_review timestamptz,p_email text,p_subject text,p_body text,p_gmail_daily int,p_gmail_hourly int,p_checked_at timestamptz)
returns setof public.outreach_queue language plpgsql security invoker set search_path='' as $$
declare u uuid; q public.outreach_queue%rowtype; p public.progress%rowtype; spread text; day_start timestamptz;
begin
 select user_id into u from public.gmail_worker_runs where id=p_run_id and status='running' and mode='live' and started_at>now()-interval '3 minutes';
 if u is null or not exists(select 1 from public.gmail_worker_control where user_id=u and enabled and pause_reason is null) then raise exception 'Live worker authorization is absent';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,0));
 if p_checked_at<now()-interval '1 minute' or p_checked_at>now()+interval '1 minute' then raise exception 'Fresh Gmail counts required';end if;
 if p_gmail_daily>=270 or p_gmail_hourly>=45 or p_gmail_daily<0 or p_gmail_hourly<0 then raise exception 'Shared Gmail sending ceiling reached';end if;
 if exists(select 1 from public.outreach_queue where user_id=u and status='sending') then raise exception 'Another sending claim requires reconciliation';end if;
 if exists(select 1 from public.ai_actions where user_id=u and (status='sending' or payload->>'sendInProgress'='true' or execution_output->>'sendInProgress'='true')) then raise exception 'AI sender ownership is active';end if;
 select * into q from public.outreach_queue where id=p_queue_id and user_id=u for update;
 if not found or q.kind<>'initial' or q.status<>'ready' or q.review_approved_at is distinct from p_review or q.verified_email is distinct from p_email or q.approved_subject is distinct from p_subject or q.approved_body is distinct from p_body or nullif(trim(q.hold_reason),'') is not null or (q.scheduled_at is not null and q.scheduled_at>now()) then raise exception 'Approved queue row changed or held';end if;
 select * into p from public.progress where user_id=u and school_id=q.school_id;
 spread:=lower(regexp_replace(coalesce(nullif(p.record->'command'->>'spreadGroup',''),nullif(p.record->>'district',''),split_part(q.verified_email,'@',2)),'[^a-zA-Z0-9]','','g'));
 day_start:=date_trunc('day',now() at time zone 'America/Boise') at time zone 'America/Boise';
 if exists(select 1 from public.outreach_queue o join public.progress op using(user_id,school_id) where o.user_id=u and (o.status='sending' or (o.status='sent' and o.sent_at>=day_start)) and lower(regexp_replace(coalesce(nullif(op.record->'command'->>'spreadGroup',''),nullif(op.record->>'district',''),split_part(o.verified_email,'@',2)),'[^a-zA-Z0-9]','','g'))=spread) then raise exception 'District already contacted today';end if;
 if (select count(*) from public.outreach_queue where user_id=u and (status='sending' or (status='sent' and sent_at>=day_start)))>=270 or (select count(*) from public.outreach_queue where user_id=u and (status='sending' or (status='sent' and sent_at>=now()-interval '1 hour')))>=45 then raise exception 'Shared CRM sending ceiling reached';end if;
 return query update public.outreach_queue set status='sending',claimed_at=now(),attempt_count=attempt_count+1,updated_at=now() where id=q.id returning *;
end; $$;
revoke all on function public.claim_gmail_initial(uuid,uuid,timestamptz,text,text,text,int,int,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_gmail_initial(uuid,uuid,timestamptz,text,text,text,int,int,timestamptz) to service_role;

create or replace function public.gmail_worker_district_context(p_user_id uuid)
returns setof jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('school_id',p.school_id,'email',p.email,'status',p.status,'record',jsonb_build_object('district',p.record->>'district','command',jsonb_build_object('spreadGroup',p.record->'command'->>'spreadGroup','workflow',p.record->'command'->'workflow'))) from public.progress p where p.user_id=p_user_id order by p.school_id;
$$;
revoke all on function public.gmail_worker_district_context(uuid) from public,anon,authenticated;
grant execute on function public.gmail_worker_district_context(uuid) to service_role;

create or replace function public.protect_initial_inflight_copy() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.kind='initial' and old.status='sending' and (new.verified_email is distinct from old.verified_email or new.approved_subject is distinct from old.approved_subject or new.approved_body is distinct from old.approved_body or new.review_approved_at is distinct from old.review_approved_at) then raise exception 'Cannot edit an initial draft while its send claim is active';end if;
 return new;
end; $$;
revoke all on function public.protect_initial_inflight_copy() from public,anon,authenticated;
create trigger protect_initial_inflight_copy before update on public.outreach_queue for each row execute function public.protect_initial_inflight_copy();

revoke all on net.http_request_queue from public,anon,authenticated;

create or replace function public.enrich_confirmed_gmail_initial() returns trigger language plpgsql security invoker set search_path='' as $$
declare p public.progress%rowtype; entries jsonb; evidence jsonb;
begin
 if new.kind<>'initial' or new.status<>'sent' or new.provider_message_id is null or new.original_thread_id is null then return new;end if;
 select * into p from public.progress where user_id=new.user_id and school_id=new.school_id for update;
 if not found then return new;end if;
 evidence:=jsonb_build_object('gmailMessageId',new.provider_message_id,'gmailThreadId',new.original_thread_id,'originalMessageId',new.provider_message_id,'originalThreadId',new.original_thread_id);
 select coalesce(jsonb_agg(case when e->>'providerMessageId'=new.provider_message_id or e->>'gmailMessageId'=new.provider_message_id then e||evidence||jsonb_build_object('note','Gmail SENT, exact recipient, subject, body and Message-ID verified. Acceptance is not proof of inbox delivery.') else e end order by n),'[]'::jsonb) into entries from jsonb_array_elements(case when jsonb_typeof(p.log)='array' then p.log else '[]'::jsonb end) with ordinality x(e,n);
 update public.progress set log=entries,record=jsonb_set(jsonb_set(coalesce(record,'{}'::jsonb),'{log}',entries),'{command}',coalesce(record->'command','{}'::jsonb)||jsonb_build_object('initialGmail',evidence||jsonb_build_object('sentAt',new.sent_at,'queueId',new.id))) where user_id=new.user_id and school_id=new.school_id;
 return new;
end; $$;
revoke all on function public.enrich_confirmed_gmail_initial() from public,anon,authenticated;
create trigger zzz_enrich_confirmed_gmail_initial after insert or update of status,provider_message_id,sent_at on public.outreach_queue for each row execute function public.enrich_confirmed_gmail_initial();
