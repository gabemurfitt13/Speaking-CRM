alter table public.outreach_queue add column if not exists review_approved_at timestamptz;
create or replace function public.approve_outreach_draft(queue_id uuid,expected_status text,reviewed_subject text,reviewed_body text,reviewed_recipient text,mark_ready boolean default true) returns public.outreach_queue
language plpgsql security invoker set search_path='' as $$
declare uid uuid:=auth.uid();q public.outreach_queue%rowtype;result public.outreach_queue%rowtype;reason text;
begin
 if uid is null then raise exception 'Sign in before reviewing outreach';end if;
 select * into q from public.outreach_queue where id=queue_id and user_id=uid for update;
 if not found then raise exception 'Queue item not found or access denied';end if;
 if q.status in ('sending','sent') then raise exception 'Sending or sent messages cannot be reopened';end if;
 if q.status is distinct from expected_status then raise exception 'Queue item changed. Refresh and review again.';end if;
 if q.approved_subject is distinct from reviewed_subject or q.approved_body is distinct from reviewed_body or q.verified_email is distinct from reviewed_recipient then raise exception 'Draft or recipient changed. Refresh and review again.';end if;
 if mark_ready and (nullif(trim(q.approved_subject),'') is null or nullif(trim(q.approved_body),'') is null or nullif(trim(q.verified_email),'') is null) then raise exception 'Recipient, subject and message are required before approval';end if;
 begin
  result:=public.review_outreach_queue(queue_id,expected_status,reviewed_subject,reviewed_body,reviewed_recipient,mark_ready);
 exception when others then
  if not mark_ready then raise;end if;
  reason:=case when sqlerrm like 'Prepare and verify the original Gmail%' then 'Original Gmail conversation check pending' else sqlerrm end;
  update public.outreach_queue set status='held',hold_reason='Approved by you; sending blocked: '||reason,updated_at=now() where id=q.id and user_id=uid returning * into result;
 end;
 if mark_ready then
 insert into public.crm_activity(user_id,record_kind,record_id,event_type,event_key,details)
 values(uid,'progress',q.school_id,case when q.kind='initial' then 'initial_outreach_approved' else 'follow_up_approved' end,
 'review:'||q.id::text||':'||md5(q.verified_email||q.approved_subject||q.approved_body),
 jsonb_build_object('queueId',q.id,'recipient',q.verified_email,'subject',q.approved_subject,'body',q.approved_body,'source','CRM user draft approval')) on conflict do nothing;
 end if;
 update public.outreach_queue set review_approved_at=case when mark_ready then now() else null end,updated_at=now() where id=q.id and user_id=uid returning * into result;
 return result;
end $$;
revoke all on function public.approve_outreach_draft(uuid,text,text,text,text,boolean) from public,anon;
grant execute on function public.approve_outreach_draft(uuid,text,text,text,text,boolean) to authenticated;
create or replace function public.clear_changed_outreach_review() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.approved_subject is distinct from old.approved_subject or new.approved_body is distinct from old.approved_body or new.verified_email is distinct from old.verified_email then new.review_approved_at:=null;end if;
 return new;
end $$;
create trigger clear_changed_outreach_review before update of approved_subject,approved_body,verified_email on public.outreach_queue for each row execute function public.clear_changed_outreach_review();