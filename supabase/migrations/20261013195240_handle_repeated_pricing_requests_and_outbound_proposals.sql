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

