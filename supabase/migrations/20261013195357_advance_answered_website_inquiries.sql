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
