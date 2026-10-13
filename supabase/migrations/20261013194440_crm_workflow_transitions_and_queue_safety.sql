-- Existing records, statuses, approval requirements and sending ceilings are preserved.
create or replace function public.crm_workflow_date(v text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare d date;
begin
 if v is null or left(v,10) !~ '^\d{4}-\d{2}-\d{2}$' then return ''; end if;
 begin d:=left(v,10)::date; exception when others then return ''; end;
 return to_char(d,'YYYY-MM-DD');
end $$;
create or replace function public.crm_workflow_business_days(v text,n integer default 5) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare d date; remaining integer:=n;
begin
 if public.crm_workflow_date(v)='' then return ''; end if;
 d:=v::date;
 while remaining>0 loop d:=d+1; if extract(isodow from d)<6 then remaining:=remaining-1; end if; end loop;
 return to_char(d,'YYYY-MM-DD');
end $$;
create or replace function public.crm_workflow_is_sent(e jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(e->>'type','') ~* '^(Email|Email sent|Initial email sent|Follow.up sent|Pricing sent|Proposal sent)$'
 and coalesce(e->>'note','') !~* 'queued|scheduled|draft|failed|bounced'
 and (coalesce(e->>'type','') ~* 'sent' or coalesce(e->>'note','') ~* 'sent|via Gmail'
 or nullif(e->>'gmailMessageId','') is not null or nullif(e->>'providerMessageId','') is not null
 or e->>'activity' in ('first_contact','follow_up'));
$$;
create or replace function public.crm_workflow_transition(c jsonb, prior jsonb default '{}', day text default to_char(now() at time zone 'America/Boise','YYYY-MM-DD'), kind text default 'progress') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 x jsonb:=coalesce(c->'command','{}'); oldx jsonb:=coalesce(prior->'command','{}');
 entries jsonb:=case when jsonb_typeof(c->'log')='array' then c->'log' when jsonb_typeof(x->'workflowLog')='array' then x->'workflowLog' else '[]'::jsonb end;
 oldentries jsonb:=case when jsonb_typeof(prior->'log')='array' then prior->'log' when jsonb_typeof(oldx->'workflowLog')='array' then oldx->'workflowLog' else '[]'::jsonb end;
 e jsonb; newreply boolean:=false; newsend boolean:=false; newproposal boolean:=false;
 sentday text:=''; replyday text:=''; s text:=coalesce(c->>'status','');
 followfield text:=case when kind='progress' then 'followUp' else 'follow_up' end;
 followday text; booked boolean; closed boolean; suppressed boolean; deferred boolean; reached boolean; reply boolean; needsreply boolean; proposal boolean; pricing boolean; verified boolean;
 lane text; label text; task text; stage text;
begin
 for e in select value from jsonb_array_elements(entries) loop
  if public.crm_workflow_is_sent(e) then sentday:=greatest(sentday,public.crm_workflow_date(coalesce(e->>'date',e->>'timestamp'))); end if;
  if e->>'type'='Reply' then replyday:=greatest(replyday,public.crm_workflow_date(coalesce(e->>'date',e->>'timestamp'))); end if;
  if not oldentries @> jsonb_build_array(e) then
   newreply:=newreply or coalesce(e->>'type'='Reply',false);
   newsend:=newsend or public.crm_workflow_is_sent(e);
   newproposal:=newproposal or coalesce(e->>'type'='Proposal sent',false);
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(entries) as pricing_entries(value) where pricing_entries.value->>'type'='Pricing request' and not oldentries @> jsonb_build_array(pricing_entries.value)) then x:=x||jsonb_build_object('pricingRequested',true,'pricingResponded',false,'replyNeedsResponse',true);end if;
 if newreply then x:=x||jsonb_build_object('replyNeedsResponse',true,'replyReceivedOn',coalesce(nullif(replyday,''),day)); end if;
 if x->>'pricingRequested'='true' and oldx->>'pricingRequested' is distinct from 'true' then x:=x||jsonb_build_object('replyNeedsResponse',true); end if;
 if x->>'pricingResponded'='true' and oldx->>'pricingResponded' is distinct from 'true' then x:=x||jsonb_build_object('replyNeedsResponse',false,'replyHandledOn',day); end if;
 if newsend and not newreply then x:=x||jsonb_build_object('replyNeedsResponse',false,'replyHandledOn',day); end if;
 newproposal:=newproposal or (x->>'proposalSentOn' is distinct from oldx->>'proposalSentOn' and public.crm_workflow_date(x->>'proposalSentOn')<>'');
 followday:=public.crm_workflow_date(coalesce(c->>followfield,c->>'followUp',c->>'follow_up'));
 if (newsend or newproposal or (s is distinct from prior->>'status' and s in ('Emailed','Quote Sent'))) and s not in ('Booked!','Booked','Completed','Not Interested','Closed') then
  if followday='' or followday<=coalesce(nullif(sentday,''),day) then
   followday:=public.crm_workflow_business_days(coalesce(nullif(sentday,''),nullif(public.crm_workflow_date(x->>'proposalSentOn'),''),day),5);
   c:=jsonb_set(c,array[followfield],to_jsonb(followday));
  end if;
 end if;
 if s in ('Booked!','Booked') and coalesce(prior->>'status','') not in ('Booked!','Booked') and nullif(x->>'bookedOn','') is null then x:=x||jsonb_build_object('bookedOn',day); end if;
 if c->>'email' is distinct from prior->>'email' and nullif(prior->>'email','') is not null then x:=x||jsonb_build_object('contactChangedOn',day); end if;
 replyday:=coalesce(nullif(replyday,''),public.crm_workflow_date(x->>'replyReceivedOn'));
 booked:=s in ('Booked!','Booked','Completed');
 closed:=s in ('Not Interested','Closed') or coalesce(x->>'doNotContact','false')='true' or coalesce(x->>'outreachPaused','false')='true';
 suppressed:=coalesce(c->>'notes','') ~* 'do not contact|opt.?out|unsubscribe|not interested';
 deferred:=s='Try Next Year';
 reached:=sentday<>'' or public.crm_workflow_date(c->>'contacted')<>'' or s in ('Emailed','Contacted','Follow-up','Left Voicemail');
 reply:=replyday<>'' or coalesce(x->>'replyNeedsResponse','false')='true' or coalesce(x->>'stage','') in ('Replied','Conversation') or s='In Discussion';
 needsreply:=coalesce(x->>'replyNeedsResponse','false')='true'
  or (replyday<>'' and (public.crm_workflow_date(x->>'replyHandledOn')='' or public.crm_workflow_date(x->>'replyHandledOn')<replyday))
  or (reply and x->>'replyNeedsResponse' is distinct from 'false' and nullif(x->>'replyHandledOn','') is null);
 proposal:=nullif(x->>'proposalSentOn','') is not null or x->>'stage'='Pricing / Proposal' or s='Quote Sent';
 pricing:=coalesce(x->>'pricingRequested','false')='true' and coalesce(x->>'pricingResponded','false')<>'true';
 verified:=coalesce(c->>'email','') ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  and lower(coalesce(c->>'contactConfidence',c->>'contact_confidence','')) in ('high','verified')
  and nullif(coalesce(c->>'contactSource',c->>'contact_source'),'') is not null
  and public.crm_workflow_date(coalesce(c->>'lastVerified',c->>'last_verified'))<>'';
 stage:=case when closed then 'Closed' when booked then 'Booked' when proposal then 'Pricing / Proposal' when s='In Discussion' or x->>'stage'='Conversation' then 'Conversation' when reply then 'Replied' when reached then 'Contacted' else 'New Lead' end;
 if closed or suppressed then lane:='paused';label:='Outreach paused';task:='paused';
 elsif deferred and (followday='' or followday>day) then lane:='paused';label:=case when followday='' then 'Set a reconnect date' else 'Reconnect '||followday end;task:='reconnect';
 elsif booked then lane:='booked';label:='Manage booked event';task:='booking';
 elsif pricing then lane:='respond';label:='Send requested pricing';task:='pricing';
 elsif needsreply or (kind='website_inquiries' and s='New') then lane:='respond';label:='Respond to inquiry';task:='reply';
 elsif proposal then lane:=case when followday<>'' and followday<=day then 'followup' else 'waiting' end;label:=case when lane='followup' then 'Follow up on proposal' else 'Await proposal decision' end;task:='proposal';
 elsif followday<>'' and followday<=day then lane:='followup';label:='Follow up today';task:='followup';
 elsif reached or reply or kind='website_inquiries' then lane:='waiting';label:=case when followday='' then 'Set a follow-up date' else 'Follow up '||followday end;task:='followup';
 elsif verified then lane:='ready';label:='Review initial outreach';task:='initial';
 else lane:='research';label:='Verify main contact';task:='verify';
 end if;
 x:=x||jsonb_build_object('stage',stage,'workflow',jsonb_build_object('lane',lane,'stage',stage,'label',label,'task',task,'due',followday,'lastSent',sentday,'lastReply',replyday,'verified',verified,'routinePaused',closed or suppressed or booked or needsreply or pricing or deferred));
 return c||jsonb_build_object('command',x);
end $$;

-- Runs after the existing progress_record_sync BEFORE trigger.
create or replace function public.apply_crm_workflow() returns trigger
language plpgsql security invoker set search_path='' as $$
declare c jsonb; oldc jsonb:='{}'; result jsonb;
begin
 if tg_table_name='progress' then
  c:=coalesce(new.record,'{}');
  if tg_op='UPDATE' then oldc:=coalesce(old.record,'{}'); end if;
 else
  c:=to_jsonb(new);
  if tg_op='UPDATE' then oldc:=to_jsonb(old); end if;
 end if;
 result:=public.crm_workflow_transition(c,oldc,to_char(now() at time zone 'America/Boise','YYYY-MM-DD'),tg_table_name);
 if tg_table_name='progress' then new.record:=result;new.follow_up:=nullif(result->>'followUp','');
  if lower(new.contact_confidence) in ('high','verified') then new.contact_confidence:=lower(new.contact_confidence);end if;
 else
  new.command:=result->'command';
  if tg_table_name='website_inquiries' then new.follow_up:=nullif(result->>'follow_up','')::date;
  else new.follow_up:=nullif(result->>'follow_up',''); end if;
 end if;
 return new;
end $$;
create trigger zz_progress_workflow before insert or update on public.progress for each row execute function public.apply_crm_workflow();
create trigger zz_leads_workflow before insert or update on public.leads for each row execute function public.apply_crm_workflow();
create trigger zz_inquiry_workflow before insert or update on public.website_inquiries for each row execute function public.apply_crm_workflow();

create or replace function public.pause_outreach_on_workflow_change() returns trigger
language plpgsql security invoker set search_path='' as $$
declare reason text; w jsonb:=new.record->'command'->'workflow';
begin
 if coalesce(w->>'routinePaused','false')='true' then reason:=coalesce(w->>'label','Workflow needs review');
 elsif tg_op='UPDATE' and (new.email is distinct from old.email or new.contact is distinct from old.contact) then reason:='Main contact changed; review recipient and message';
 elsif coalesce(w->>'verified','false')<>'true' then reason:='Main contact verification requires review';
 end if;
 update public.outreach_queue q set status='held',
  hold_reason=coalesce(reason,'Initial outreach already recorded; review follow-up'),updated_at=now()
 where q.user_id=new.user_id and q.school_id=new.school_id and q.status in ('ready','scheduled','failed')
  and (reason is not null or (q.kind='initial' and (coalesce(new.contacted,'')<>'' or new.status<>'Not Started')));
 return new;
end $$;
create trigger zz_progress_pause_outreach after insert or update on public.progress for each row execute function public.pause_outreach_on_workflow_change();

-- Recheck current facts before claims; never reopen sent or in-flight messages.
create or replace function public.guard_workflow_outreach_claim() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p public.progress%rowtype; c jsonb; w jsonb;
begin
 if new.status<>'sending' or old.status='sending' then return new;end if;
 select * into p from public.progress where user_id=new.user_id and school_id=new.school_id;
 if not found then raise exception 'Prospect not found';end if;
 c:=public.crm_workflow_transition(coalesce(p.record,'{}'),coalesce(p.record,'{}'),to_char(now() at time zone 'America/Boise','YYYY-MM-DD'),'progress');
 w:=c->'command'->'workflow';
 if coalesce(w->>'routinePaused','false')='true' then raise exception 'Workflow paused outreach: %',w->>'label';end if;
 if lower(trim(coalesce(p.email,'')))<>lower(trim(coalesce(new.verified_email,''))) then raise exception 'Main contact changed; review the recipient';end if;
 return new;
end $$;
create trigger zz_workflow_outreach_claim before update of status on public.outreach_queue for each row execute function public.guard_workflow_outreach_claim();
revoke all on function public.crm_workflow_date(text),public.crm_workflow_business_days(text,integer),public.crm_workflow_is_sent(jsonb),public.crm_workflow_transition(jsonb,jsonb,text,text),public.apply_crm_workflow(),public.pause_outreach_on_workflow_change(),public.guard_workflow_outreach_claim() from public,anon;
grant execute on function public.crm_workflow_date(text),public.crm_workflow_business_days(text,integer),public.crm_workflow_is_sent(jsonb),public.crm_workflow_transition(jsonb,jsonb,text,text),public.apply_crm_workflow(),public.pause_outreach_on_workflow_change(),public.guard_workflow_outreach_claim() to authenticated,service_role;

create or replace function public.record_crm_workflow_event(record_kind text,record_id text,action text,follow_up_date text default '',note text default '') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare uid uuid:=auth.uid(); c jsonb; cmd jsonb; entry jsonb; entries jsonb; result jsonb; day text:=to_char(now() at time zone 'America/Boise','YYYY-MM-DD'); newstatus text;
begin
 if uid is null then raise exception 'Sign in before updating CRM workflow';end if;
 if record_kind='progress' then select record into c from public.progress where user_id=uid and school_id=record_id for update;
 elsif record_kind='leads' then select to_jsonb(l) into c from public.leads l where user_id=uid and l.id::text=record_id for update;
 elsif record_kind='website_inquiries' then select to_jsonb(i) into c from public.website_inquiries i where user_id=uid and i.id::text=record_id for update;
 else raise exception 'Unsupported record type';end if;
 if c is null then raise exception 'Record not found or access denied';end if;
 if follow_up_date<>'' and public.crm_workflow_date(follow_up_date)<>follow_up_date then raise exception 'Invalid follow-up date';end if;
 if action='schedule' and follow_up_date='' then raise exception 'Choose a follow-up date';end if;
 cmd:=coalesce(c->'command','{}');
 entries:=case when jsonb_typeof(c->'log')='array' then c->'log' when jsonb_typeof(cmd->'workflowLog')='array' then cmd->'workflowLog' else '[]'::jsonb end;
 entry:=jsonb_build_object('date',day,'timestamp',now(),'note',coalesce(nullif(trim(note),''),'Recorded by CRM owner')||' · '||action);
 newstatus:=c->>'status';
 case action
 when 'reply' then entry:=entry||jsonb_build_object('type','Reply');cmd:=cmd||jsonb_build_object('replyNeedsResponse',true,'replyReceivedOn',day);
 when 'pricing_requested' then entry:=entry||jsonb_build_object('type','Pricing request');cmd:=cmd||jsonb_build_object('pricingRequested',true,'pricingResponded',false,'replyNeedsResponse',true);
 when 'pricing_sent' then if record_kind='website_inquiries' and newstatus='New' then newstatus:='Contacted';end if;entry:=entry||jsonb_build_object('type','Pricing sent');cmd:=cmd||jsonb_build_object('pricingResponded',true,'replyNeedsResponse',false,'replyHandledOn',day,'stage','Conversation');
 when 'proposal_sent' then entry:=entry||jsonb_build_object('type','Proposal sent');cmd:=cmd||jsonb_build_object('proposalSentOn',day,'replyNeedsResponse',false,'replyHandledOn',day);newstatus:=case when record_kind='website_inquiries' then 'Contacted' else 'Quote Sent' end;
 when 'response_sent' then if record_kind='website_inquiries' and newstatus='New' then newstatus:='Contacted';end if;entry:=entry||jsonb_build_object('type','Email sent','activity','follow_up');cmd:=cmd||jsonb_build_object('replyNeedsResponse',false,'replyHandledOn',day);
 when 'booked' then entry:=entry||jsonb_build_object('type','Booking');newstatus:=case when record_kind='progress' then 'Booked!' else 'Booked' end;
 when 'closed' then entry:=entry||jsonb_build_object('type','Note');newstatus:=case when record_kind='website_inquiries' then 'Closed' else 'Not Interested' end;cmd:=cmd||jsonb_build_object('outreachPaused',true);
 when 'contract_signed' then entry:=entry||jsonb_build_object('type','Note');cmd:=cmd||jsonb_build_object('contractStatus','Signed');
 when 'deposit_received' then entry:=entry||jsonb_build_object('type','Note');cmd:=cmd||jsonb_build_object('depositReceived',true);
 when 'schedule' then entry:=entry||jsonb_build_object('type','Note');
 else raise exception 'Unknown workflow action';end case;
 entries:=jsonb_build_array(entry)||entries;
 result:=c||jsonb_build_object('command',cmd,'status',newstatus,'log',entries);
 if follow_up_date<>'' then result:=jsonb_set(result,array[case when record_kind='progress' then 'followUp' else 'follow_up' end],to_jsonb(follow_up_date));end if;
 if record_kind='progress' then
  update public.progress set record=result,status=newstatus,log=entries,follow_up=coalesce(nullif(follow_up_date,''),follow_up)
  where user_id=uid and school_id=record_id returning record into result;
 elsif record_kind='leads' then
  update public.leads l set command=cmd,status=newstatus,log=entries,follow_up=coalesce(nullif(follow_up_date,''),l.follow_up)
  where user_id=uid and l.id::text=record_id returning to_jsonb(l) into result;
 else
  cmd:=cmd||jsonb_build_object('workflowLog',entries);
  update public.website_inquiries i set command=cmd,status=newstatus,follow_up=coalesce(nullif(follow_up_date,'')::date,i.follow_up)
  where user_id=uid and i.id::text=record_id returning to_jsonb(i) into result;
 end if;
 return result;
end $$;
revoke all on function public.record_crm_workflow_event(text,text,text,text,text) from public,anon;
grant execute on function public.record_crm_workflow_event(text,text,text,text,text) to authenticated;
