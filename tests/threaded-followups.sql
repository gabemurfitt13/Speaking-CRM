-- Run inside a rollback transaction after the additive migration is loaded.
insert into public.progress(user_id,school_id,status,contact,email,contact_confidence,contact_source,last_verified,contacted,follow_up,record,log)
values('344e07b9-d80c-4960-aa61-2732e73cbe59','qa-threaded-followup','Emailed','QA Principal','qa-threaded@example.edu','high','https://example.edu/qa','2026-10-13','2026-10-05','2026-10-12',jsonb_build_object('id','qa-threaded-followup','type','High School','school','QA Test High School','status','Emailed','email','qa-threaded@example.edu','contactConfidence','high','contactSource','https://example.edu/qa','lastVerified','2026-10-13','contacted','2026-10-05','followUp','2026-10-12','command','{}'::jsonb),'[]');
insert into public.outreach_queue(user_id,school_id,kind,status,verified_email,approved_subject,approved_body,original_message_id,original_thread_id,original_rfc_message_id,original_references,original_sent_at,follow_up_due,thread_checked_at,thread_check_result,thread_check_evidence,approval_scope)
values('344e07b9-d80c-4960-aa61-2732e73cbe59','qa-threaded-followup','follow_up','ready','qa-threaded@example.edu','Re: quick question','QA NOT TO BE SENT','qa-original','qa-thread','<qa-original@example.edu>','<qa-original@example.edu>','2026-10-05T16:00:00Z','2026-10-12',now(),'unanswered','{"originalMessageId":"qa-original","threadId":"qa-thread","recipient":"qa-threaded@example.edu"}','gabe-school-silence-followups-20261013');
do $$
declare denied boolean; msg text; qid uuid;
begin
 select id into qid from public.outreach_queue where school_id='qa-threaded-followup' and kind='follow_up';
 update public.outreach_queue set status='sending',claimed_at=now() where id=qid;
 if not exists(select 1 from public.outreach_queue where id=qid and status='sending') then raise exception 'Eligible reviewed follow-up did not claim';end if;
 update public.outreach_queue set status='held',claimed_at=null where id=qid;
 update public.outreach_queue set status='ready',original_thread_id=null where id=qid;
 denied:=false;begin update public.outreach_queue set status='sending' where id=qid;exception when others then denied:=true;msg:=sqlerrm;end;
 if not denied or msg not like '%threading headers missing%' then raise exception 'Missing original thread not blocked: %',msg;end if;
 update public.outreach_queue set original_thread_id='qa-thread',thread_check_result='human_response' where id=qid;
 denied:=false;begin update public.outreach_queue set status='sending' where id=qid;exception when others then denied:=true;msg:=sqlerrm;end;
 if not denied or msg not like '%Fresh complete Gmail%' then raise exception 'Human response not blocked: %',msg;end if;
 update public.outreach_queue set thread_check_result='unanswered',thread_checked_at=now()-interval '6 minutes' where id=qid;
 denied:=false;begin update public.outreach_queue set status='sending' where id=qid;exception when others then denied:=true;msg:=sqlerrm;end;
 if not denied or msg not like '%Fresh complete Gmail%' then raise exception 'Stale preflight not blocked: %',msg;end if;
 update public.outreach_queue set thread_checked_at=now() where id=qid;
 update public.progress set status='In Discussion' where school_id='qa-threaded-followup';
 if not exists(select 1 from public.outreach_queue where id=qid and status='held') then raise exception 'Reply/status did not suppress prepared follow-up';end if;
 update public.outreach_queue set status='ready' where id=qid;
 denied:=false;begin update public.outreach_queue set status='sending' where id=qid;exception when others then denied:=true;msg:=sqlerrm;end;
 if not denied or msg not like '%In Discussion is excluded%' then raise exception 'In Discussion not blocked: %',msg;end if;
 update public.progress set status='Emailed',record=record||jsonb_build_object('command','{}'::jsonb) where school_id='qa-threaded-followup';
 update public.outreach_queue set status='ready' where id=qid;
 update public.outreach_queue set status='sending' where id=qid;
 denied:=false;begin update public.outreach_queue set status='sent',provider_message_id='qa-sent',sent_at=now(),follow_up_thread_id='other-thread' where id=qid;exception when others then denied:=true;msg:=sqlerrm;end;
 if not denied or msg not like '%matching Gmail thread%' then raise exception 'Split-thread confirmation not blocked: %',msg;end if;
 update public.outreach_queue set status='sent',provider_message_id='qa-sent',sent_at=now(),follow_up_thread_id='qa-thread',claimed_at=null where id=qid;
 if not exists(select 1 from public.progress where school_id='qa-threaded-followup' and nullif(follow_up,'') is null and record->'command'->'schoolFollowup'->>'messageId'='qa-sent') then raise exception 'Successful confirmation did not synchronize log and clear due date';end if;
 if (select count(*) from public.progress p,jsonb_array_elements(p.log) e where p.school_id='qa-threaded-followup' and e->>'gmailMessageId'='qa-sent')<>1 then raise exception 'Sent log not recorded exactly once';end if;
 update public.outreach_queue set status='sent' where id=qid;
 if (select count(*) from public.progress p,jsonb_array_elements(p.log) e where p.school_id='qa-threaded-followup' and e->>'gmailMessageId'='qa-sent')<>1 then raise exception 'Idempotent confirmation duplicated sent log';end if;
end $$;
select 'threaded follow-up claim, reply suppression, missing metadata, stale check, split thread and idempotent synchronization passed' test_result;
