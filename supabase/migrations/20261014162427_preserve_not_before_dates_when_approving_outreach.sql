create or replace function public.review_outreach_queue(queue_id uuid,expected_status text,reviewed_subject text,reviewed_body text,reviewed_recipient text,mark_ready boolean default true) returns public.outreach_queue
language plpgsql security invoker set search_path='' as $$
declare uid uuid:=auth.uid(); q public.outreach_queue%rowtype; p public.progress%rowtype; w jsonb;
begin
 if uid is null then raise exception 'Sign in before reviewing outreach';end if;
 select * into q from public.outreach_queue where id=queue_id and user_id=uid for update;
 if not found then raise exception 'Queue item not found or access denied';end if;
 if q.status in ('sending','sent') then raise exception 'Sending or sent messages cannot be reopened';end if;
 if q.status is distinct from expected_status then raise exception 'Queue item changed. Refresh and review again.';end if;
 if not mark_ready then update public.outreach_queue set status='held',hold_reason='Manually paused after review',updated_at=now() where id=q.id and user_id=uid returning * into q;return q;end if;
 if q.approved_subject is distinct from reviewed_subject or q.approved_body is distinct from reviewed_body or q.verified_email is distinct from reviewed_recipient then raise exception 'Draft or recipient changed. Refresh and review again.';end if;
 if nullif(trim(q.approved_subject),'') is null or nullif(trim(q.approved_body),'') is null then raise exception 'Review and save the subject and message first';end if;
 select * into p from public.progress where user_id=uid and school_id=q.school_id;
 if not found then raise exception 'Saved prospect not found';end if;
 if lower(trim(coalesce(p.email,'')))<>lower(trim(coalesce(q.verified_email,''))) then raise exception 'Main contact changed. Review recipient and draft.';end if;
 if lower(coalesce(p.contact_confidence,'')) not in ('high','verified') or nullif(trim(p.contact_source),'') is null or public.crm_workflow_date(p.last_verified)='' then raise exception 'Verify the main contact, source and date before approval';end if;
 w:=public.crm_workflow_transition(coalesce(p.record,'{}'),coalesce(p.record,'{}'),to_char(now() at time zone 'America/Boise','YYYY-MM-DD'),'progress')->'command'->'workflow';
 if w->>'routinePaused'='true' or coalesce(p.status,'') ~* 'not interested|booked|in discussion|try next year|closed' then raise exception 'Outreach paused: %',coalesce(w->>'label',p.status);end if;
 if q.kind='initial' then
  if p.status<>'Not Started' or nullif(trim(p.contacted),'') is not null or exists(select 1 from jsonb_array_elements(coalesce(p.log,'[]')) e where public.crm_workflow_is_sent(e)) then raise exception 'Initial outreach already recorded. Review a follow-up instead.';end if;
 elsif q.kind='follow_up' then
  if p.status<>'Emailed' then raise exception 'Only unanswered Emailed schools are eligible for routine follow-ups';end if;
  if q.approval_scope is distinct from 'gabe-school-silence-followups-20261013' or q.original_message_id is null or q.original_thread_id is null then raise exception 'Prepare and verify the original Gmail conversation before approving this follow-up';end if;
 else raise exception 'Unsupported outreach type';end if;
 insert into public.crm_activity(user_id,record_kind,record_id,event_type,event_key,details)
 values(uid,'progress',q.school_id,case when q.kind='initial' then 'initial_outreach_approved' else 'follow_up_approved' end,
 'review:'||q.id::text||':'||md5(q.verified_email||q.approved_subject||q.approved_body),
 jsonb_build_object('queueId',q.id,'recipient',q.verified_email,'subject',q.approved_subject,'body',q.approved_body,'source','CRM Ready to Send checkbox'))
 on conflict do nothing;
 update public.outreach_queue set status=case when scheduled_at>now() then 'scheduled' else 'ready' end,hold_reason=null,updated_at=now() where id=q.id and user_id=uid returning * into q;
 return q;
end $$;
revoke all on function public.review_outreach_queue(uuid,text,text,text,text,boolean) from public,anon;
grant execute on function public.review_outreach_queue(uuid,text,text,text,text,boolean) to authenticated;