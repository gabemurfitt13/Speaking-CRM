-- Run after schema source inside one transaction; caller must roll back.
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare u uuid; r uuid; q public.outreach_queue%rowtype; n int; rejected boolean;
begin
 select user_id into u from public.gmail_connections where mailbox='gabemurfittspeaker@gmail.com';
 insert into public.gmail_worker_control(user_id,enabled) values(u,true);
 insert into public.gmail_worker_runs(user_id,mode,max_sends,status,started_at) values(u,'live',1,'running',now()) returning id into r;
 -- Temporarily isolate the test from a pre-existing claim. Entire transaction is rolled back.
 update public.outreach_queue set status='held' where user_id=u and status='sending';
 select * into q from public.outreach_queue where user_id=u and kind='initial' and status='ready' and school_id like 'mi-%' and review_approved_at is not null limit 1;
 if q.id is null then raise exception 'No approved test candidate';end if;
 select count(*) into n from public.claim_gmail_initial(r,q.id,q.review_approved_at,q.verified_email,q.approved_subject,q.approved_body,0,0,now());
 if n<>1 then raise exception 'Approved claim did not return one row';end if;
 rejected:=false;
 begin update public.outreach_queue set approved_body='changed' where id=q.id;exception when others then rejected:=true;end;
 if not rejected then raise exception 'In-flight draft modification was allowed';end if;
 update public.outreach_queue set status='sent',provider_message_id='qa-rollback-only-gmail',original_message_id='qa-rollback-only-gmail',original_thread_id='qa-rollback-only-thread',sent_at=now(),claimed_at=null where id=q.id;
 if not exists(select 1 from public.progress where user_id=u and school_id=q.school_id and status='Emailed' and record->'command'->'initialGmail'->>'gmailMessageId'='qa-rollback-only-gmail') then raise exception 'Confirmed Gmail status/evidence sync failed';end if;
 rejected:=false;
 begin update public.outreach_queue set status='ready' where id=q.id;exception when others then rejected:=true;end;
 if not rejected then raise exception 'Confirmed send was reopened';end if;
 if has_table_privilege('authenticated','public.gmail_worker_runs','select') or has_function_privilege('anon','public.request_gmail_outreach_worker(text,integer)','execute') then raise exception 'Worker permissions exposed';end if;
 update public.gmail_worker_runs set status='completed' where id=r;
 insert into public.gmail_worker_runs(user_id,mode,max_sends,token_hash) values(u,'dry_run',1,encode(sha256(convert_to(repeat('x',72),'UTF8')),'hex')) returning id into r;
 select count(*) into n from public.claim_gmail_worker_request(r,repeat('x',72));if n<>1 then raise exception 'Valid one-time token rejected';end if;
 select count(*) into n from public.claim_gmail_worker_request(r,repeat('x',72));if n<>0 then raise exception 'Worker token replay was allowed';end if;
end $$;
select 'PASS: conditional approval claim, frozen copy, Gmail CRM sync, sent immutability, worker ACLs, one-time token replay' as validation;
