-- Applied to CLEAR CRM on 2026-10-22 at Gabe's explicit request.
-- Removes the blanket same-district/day gate for approved school follow-ups.
-- Retains authorization, original-thread checks, duplicate guards, and shared ceilings.
CREATE OR REPLACE FUNCTION public.claim_gmail_followup(p_run_id uuid, p_queue_id uuid, p_review timestamp with time zone, p_email text, p_subject text, p_body text, p_gmail_daily integer, p_gmail_hourly integer, p_checked_at timestamp with time zone, p_match jsonb)
 RETURNS SETOF outreach_queue
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare u uuid; q public.outreach_queue%rowtype; day_start timestamptz;
begin
 select user_id into u from public.gmail_worker_runs where id=p_run_id and status='running' and mode='live' and started_at>now()-interval '3 minutes';
 if u is null or not exists(select 1 from public.gmail_worker_control where user_id=u and enabled and pause_reason is null and outreach_kind='follow_up' and followups_authorized_until>now()) then raise exception 'Live worker authorization is absent';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,0));
 if p_checked_at<now()-interval '1 minute' or p_checked_at>now()+interval '1 minute' then raise exception 'Fresh Gmail counts required';end if;
 if p_gmail_daily>=270 or p_gmail_hourly>=45 or p_gmail_daily<0 or p_gmail_hourly<0 then raise exception 'Shared Gmail sending ceiling reached';end if;
 if exists(select 1 from public.outreach_queue where user_id=u and status='sending') then raise exception 'Another sending claim requires reconciliation';end if;
 if exists(select 1 from public.ai_actions where user_id=u and (status='sending' or payload->>'sendInProgress'='true' or execution_output->>'sendInProgress'='true')) then raise exception 'AI sender ownership is active';end if;
 select * into q from public.outreach_queue where id=p_queue_id and user_id=u for update;
 if not found or q.kind<>'follow_up' or q.status not in ('held','ready') or q.review_approved_at is null or q.provider_message_id is not null or q.review_approved_at is distinct from p_review or q.verified_email is distinct from p_email or q.approved_subject is distinct from p_subject or q.approved_body is distinct from p_body or (q.status='ready' and nullif(trim(q.hold_reason),'') is not null) or (q.status='held' and q.hold_reason is distinct from 'Approved by you; sending blocked: Original Gmail conversation check pending' and coalesce(q.hold_reason,'') !~ '^Your saved draft is approved[.] Original Gmail thread matched[.;].*(RATE_LIMIT_EXCEEDED|403|blocked)') or (q.scheduled_at is not null and q.scheduled_at>now()) then raise exception 'Approved queue row changed or held';end if;
 if p_match->>'originalMessageId' is distinct from q.original_message_id or p_match->>'threadId' is distinct from q.original_thread_id or p_match->>'subject' is distinct from q.approved_subject or lower(p_match->>'recipient') is distinct from lower(q.verified_email) or p_match->>'eligible' is distinct from 'true' or p_match->>'allMailChecked' is distinct from 'true' or p_match->>'completeThreadChecked' is distinct from 'true' or (p_match->>'checkedAt')::timestamptz<now()-interval '5 minutes' then raise exception 'Complete fresh matching Gmail preflight required';end if;
 day_start:=date_trunc('day',now() at time zone 'America/Boise') at time zone 'America/Boise';
 if (select count(*) from public.outreach_queue where user_id=u and (status='sending' or (status='sent' and sent_at>=day_start)))>=270 or (select count(*) from public.outreach_queue where user_id=u and (status='sending' or (status='sent' and sent_at>=now()-interval '1 hour')))>=45 then raise exception 'Shared CRM sending ceiling reached';end if;
 update public.outreach_queue set status='ready',hold_reason=null,approval_scope='gabe-school-silence-followups-20261013',original_rfc_message_id=p_match->>'rfcMessageId',original_references=p_match->>'references',original_sent_at=(p_match->>'originalSentAt')::timestamptz,follow_up_due=(p_match->>'due')::date,thread_check_result='unanswered',thread_checked_at=now(),thread_check_evidence=coalesce(thread_check_evidence,'{}'::jsonb)||p_match,updated_at=now() where id=q.id;
 return query update public.outreach_queue set status='sending',claimed_at=now(),attempt_count=attempt_count+1,updated_at=now() where id=q.id returning *;
end; $function$
