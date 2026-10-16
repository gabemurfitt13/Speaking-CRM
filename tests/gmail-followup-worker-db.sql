begin;
do $$
declare u uuid; q public.outreach_queue%rowtype; run_id uuid; evidence jsonb; n int; rejected bool; saved_record jsonb;
begin
 select user_id into u from public.gmail_connections where mailbox='gabemurfittspeaker@gmail.com' and status='connected';
 select * into q from public.outreach_queue where user_id=u and school_id='ut-089' and kind='follow_up' and status='held';
 if q.id is null or q.review_approved_at is null then raise exception 'Approved unsent test fixture unavailable';end if;
 update public.gmail_worker_control set enabled=true,pause_reason=null,outreach_kind='follow_up',followups_authorized_until=now()+interval '1 hour' where user_id=u;
 insert into public.gmail_worker_runs(user_id,mode,max_sends,status,started_at) values(u,'live',1,'running',now()) returning id into run_id;
 evidence:=jsonb_build_object('eligible',true,'originalMessageId',q.original_message_id,'threadId',q.original_thread_id,'subject',q.approved_subject,'recipient',q.verified_email,'rfcMessageId',q.original_rfc_message_id,'references',q.original_references,'originalSentAt',q.original_sent_at,'due',q.follow_up_due,'checkedAt',now(),'allMailChecked',true,'completeThreadChecked',true);
 rejected:=false;begin perform public.claim_gmail_followup(run_id,q.id,q.review_approved_at,q.verified_email,q.approved_subject,q.approved_body,1,45,now(),evidence);exception when others then if sqlerrm like '%ceiling%' then rejected:=true;else raise;end if;end;if not rejected then raise exception 'Hourly cap bypassed';end if;
 rejected:=false;begin perform public.claim_gmail_followup(run_id,q.id,q.review_approved_at,null,q.approved_subject,q.approved_body,1,1,now(),evidence);exception when others then if sqlerrm like '%changed or held%' then rejected:=true;else raise;end if;end;if not rejected then raise exception 'Changed address bypassed';end if;
 select record into saved_record from public.progress where user_id=u and school_id=q.school_id;
 update public.progress set status='In Discussion' where user_id=u and school_id=q.school_id;
 rejected:=false;begin perform public.claim_gmail_followup(run_id,q.id,q.review_approved_at,q.verified_email,q.approved_subject,q.approved_body,1,1,now(),evidence);exception when others then if sqlerrm like '%In Discussion%' then rejected:=true;else raise;end if;end;if not rejected then raise exception 'Discussion suppression bypassed';end if;
 update public.progress set status='Emailed',record=saved_record where user_id=u and school_id=q.school_id;
 select count(*) into n from public.claim_gmail_followup(run_id,q.id,q.review_approved_at,q.verified_email,q.approved_subject,q.approved_body,1,1,now(),evidence);if n<>1 then raise exception 'Valid approved claim did not succeed';end if;
 rejected:=false;begin update public.outreach_queue set approved_body='changed' where id=q.id;exception when others then rejected:=true;end;if not rejected then raise exception 'Inflight copy can be edited';end if;
 if not exists(select 1 from public.outreach_queue where id=q.id and status='sending' and original_message_id=q.original_message_id and review_approved_at=q.review_approved_at) then raise exception 'Claim lost approval or original identity';end if;
 raise notice 'PASS: caps, address approval, In Discussion, exact approved claim and inflight protection';
end $$;
rollback;
