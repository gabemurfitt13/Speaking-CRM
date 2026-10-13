-- Reuse outreach_queue; no new sender or credential store.
alter table public.outreach_queue add column if not exists original_message_id text;
alter table public.outreach_queue add column if not exists original_thread_id text;
alter table public.outreach_queue add column if not exists original_rfc_message_id text;
alter table public.outreach_queue add column if not exists original_references text;
alter table public.outreach_queue add column if not exists original_sent_at timestamptz;
alter table public.outreach_queue add column if not exists follow_up_due date;
alter table public.outreach_queue add column if not exists thread_checked_at timestamptz;
alter table public.outreach_queue add column if not exists thread_check_result text;
alter table public.outreach_queue add column if not exists thread_check_evidence jsonb;
alter table public.outreach_queue add column if not exists follow_up_thread_id text;
alter table public.outreach_queue add column if not exists approval_scope text;
create or replace function public.guard_threaded_school_followup() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p public.progress%rowtype; localnow timestamp:=now() at time zone 'America/Boise'; total integer; hourly integer;
begin
 if new.kind<>'follow_up' then return new;end if;
 if tg_op='INSERT' and new.status='sending' then raise exception 'Create a reviewed follow-up, then claim conditionally';end if;
 if tg_op='UPDATE' and old.status='sent' and (new.original_message_id is distinct from old.original_message_id or new.original_thread_id is distinct from old.original_thread_id or new.follow_up_thread_id is distinct from old.follow_up_thread_id) then raise exception 'Sent follow-up thread evidence is immutable';end if;
 if new.status='sent' then
  if new.provider_message_id is null or new.sent_at is null or new.original_message_id is null or new.original_thread_id is null or new.follow_up_thread_id is distinct from new.original_thread_id then raise exception 'Confirmed matching Gmail thread and sent message required';end if;
 end if;
 if new.status<>'sending' or (tg_op='UPDATE' and old.status='sending') then return new;end if;
 if old.status not in ('ready','scheduled') or (old.status='scheduled' and old.scheduled_at>now()) then raise exception 'Follow-up is held or not due';end if;
 if new.approval_scope<>'gabe-school-silence-followups-20261013' or new.approval_scope is null or nullif(new.approved_body,'') is null then raise exception 'School silence follow-up approval is required';end if;
 select * into p from public.progress where user_id=new.user_id and school_id=new.school_id;
 if not found or p.status<>'Emailed' then raise exception 'Only unanswered Emailed schools are eligible; In Discussion is excluded';end if;
 if coalesce(p.record->>'type','') !~* '(school|high|middle|K-8|elementary)' or coalesce(p.record->>'type','') ~* '(conference|church|business|college|university)' then raise exception 'Direct schools only';end if;
 if lower(trim(p.email))<>lower(trim(new.verified_email)) or coalesce(lower(p.contact_confidence),'') not in ('high','verified') or nullif(p.contact_source,'') is null or p.last_verified is null then raise exception 'Verified matching school recipient required';end if;
 if new.original_message_id is null or new.original_thread_id is null or coalesce(new.original_rfc_message_id,'') !~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$' or position(new.original_rfc_message_id in coalesce(new.original_references,''))=0 then raise exception 'Original Gmail threading headers missing';end if;
 if new.original_sent_at is null or new.original_sent_at<now()-interval '45 days' then raise exception 'Old or unmatched outreach requires reconnect review';end if;
 if new.follow_up_due is null or new.follow_up_due>localnow::date or new.follow_up_due<public.crm_workflow_business_days(to_char(new.original_sent_at at time zone 'America/Boise','YYYY-MM-DD'),5)::date then raise exception 'Follow-up is not due';end if;
 if new.thread_check_result is distinct from 'unanswered' or new.thread_checked_at is null or new.thread_checked_at<now()-interval '5 minutes' or new.thread_checked_at>now()+interval '1 minute' then raise exception 'Fresh complete Gmail conversation check required';end if;
 if new.thread_check_evidence->>'originalMessageId' is distinct from new.original_message_id or new.thread_check_evidence->>'threadId' is distinct from new.original_thread_id or lower(new.thread_check_evidence->>'recipient') is distinct from lower(new.verified_email) then raise exception 'Thread verification evidence does not match';end if;
 if extract(isodow from localnow)>5 or localnow::time<time '09:00' or localnow::time>=time '15:00' then raise exception 'Outside Boise weekday sending hours';end if;
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
 if exists(select 1 from public.outreach_queue q where q.user_id=new.user_id and q.id<>new.id and (q.status='sending' or (q.kind='follow_up' and (q.original_thread_id=new.original_thread_id or lower(q.verified_email)=lower(new.verified_email)) and q.status='sent'))) then raise exception 'Another send is active or this follow-up already exists';end if;
 select count(*) filter(where q.status='sending' or q.sent_at>=now()-interval '1 hour'),count(*) into hourly,total from public.outreach_queue q join public.progress r using(user_id,school_id) where q.user_id=new.user_id and q.kind in ('initial','follow_up') and (q.status='sending' or (q.status='sent' and (q.sent_at at time zone 'America/Boise')::date=localnow::date)) and coalesce(r.record->>'type','') !~* '(conference|church|business|college|university)';
 if hourly>=45 or total>=270 then raise exception 'Shared school sending ceiling reached';end if;
 return new;
end $$;
create trigger guard_threaded_school_followup before insert or update on public.outreach_queue for each row execute function public.guard_threaded_school_followup();

create or replace function public.sync_confirmed_school_followup() returns trigger
language plpgsql security invoker set search_path='' as $$
declare entry jsonb; day text; p public.progress%rowtype;
begin
 if new.kind<>'follow_up' or new.status<>'sent' or new.provider_message_id is null or new.sent_at is null then return new;end if;
 select * into p from public.progress where user_id=new.user_id and school_id=new.school_id;
 if not found then return new;end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p.log,'[]')) e where coalesce(e->>'gmailMessageId',e->>'providerMessageId')=new.provider_message_id) then return new;end if;
 day:=to_char(new.sent_at at time zone 'America/Boise','YYYY-MM-DD');
 entry:=jsonb_build_object('date',day,'timestamp',new.sent_at,'type','Follow-up sent','activity','follow_up','recipient',new.verified_email,'subject',new.approved_subject,'gmailMessageId',new.provider_message_id,'gmailThreadId',new.follow_up_thread_id,'originalMessageId',new.original_message_id,'originalThreadId',new.original_thread_id,'queueId',new.id,'note','Gmail SENT and original conversation verified; provider acceptance is not proof of inbox delivery.');
 update public.progress set log=coalesce(log,'[]')||jsonb_build_array(entry),follow_up=null,record=record||jsonb_build_object('followUp','','command',coalesce(record->'command','{}')||jsonb_build_object('schoolFollowup',jsonb_build_object('state','sent','sentAt',new.sent_at,'messageId',new.provider_message_id,'threadId',new.follow_up_thread_id,'originalMessageId',new.original_message_id,'originalThreadId',new.original_thread_id))) where user_id=new.user_id and school_id=new.school_id;
 -- Existing workflow assigns dates to new sends. A sent silence follow-up has no automatic second send.
 update public.progress set follow_up=null,record=jsonb_set(record,'{followUp}',to_jsonb(''::text)) where user_id=new.user_id and school_id=new.school_id;
 return new;
end $$;
create trigger sync_confirmed_school_followup after insert or update of status,provider_message_id,sent_at on public.outreach_queue for each row execute function public.sync_confirmed_school_followup();

create or replace function public.suppress_answered_school_followup() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.status<>'Emailed' or coalesce(new.record->'command'->>'replyNeedsResponse','false')='true' or exists(select 1 from jsonb_array_elements(coalesce(new.log,'[]')) e where e->>'type'='Reply') then
  update public.outreach_queue set status='held',thread_check_result='suppressed',hold_reason='School has responded or CRM status is not Emailed; silence follow-up suppressed',updated_at=now() where user_id=new.user_id and school_id=new.school_id and kind='follow_up' and status in ('ready','scheduled');
 end if;
 return new;
end $$;
create trigger zzz_suppress_answered_school_followup after update on public.progress for each row execute function public.suppress_answered_school_followup();

create or replace function public.schedule_school_followup_from_initial() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p public.progress%rowtype; due date;
begin
 if new.kind<>'initial' or new.status<>'sent' or new.provider_message_id is null or new.sent_at is null or new.sent_at<now()-interval '45 days' then return new;end if;
 select * into p from public.progress where user_id=new.user_id and school_id=new.school_id;
 if not found or coalesce(p.record->>'type','') !~* '(school|high|middle|K-8|elementary)' or coalesce(p.record->>'type','') ~* '(conference|church|business|college|university)' then return new;end if;
 due:=public.crm_workflow_business_days(to_char(new.sent_at at time zone 'America/Boise','YYYY-MM-DD'),5)::date;
 insert into public.outreach_queue(user_id,school_id,kind,status,verified_email,original_message_id,original_sent_at,follow_up_due,hold_reason) values(new.user_id,new.school_id,'follow_up','held',new.verified_email,new.provider_message_id,new.sent_at,due,'Original Gmail thread preflight required before school follow-up') on conflict(user_id,school_id,kind) do nothing;
 update public.progress set follow_up=due::text,record=jsonb_set(record,'{followUp}',to_jsonb(due::text)) where user_id=new.user_id and school_id=new.school_id and status='Emailed';
 return new;
end $$;
create trigger zz_schedule_school_followup_from_initial after insert or update of status,provider_message_id,sent_at on public.outreach_queue for each row execute function public.schedule_school_followup_from_initial();
revoke all on function public.guard_threaded_school_followup(),public.sync_confirmed_school_followup(),public.suppress_answered_school_followup(),public.schedule_school_followup_from_initial() from public,anon;
grant execute on function public.guard_threaded_school_followup(),public.sync_confirmed_school_followup(),public.suppress_answered_school_followup(),public.schedule_school_followup_from_initial() to authenticated,service_role;
