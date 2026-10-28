-- Keep the existing records and sending workflow. This API only edits sales work.
create or replace function public.save_crm_sales_workspace(record_kind text,record_id text,expected_revision text,operation text,payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare uid uuid:=auth.uid(); c jsonb; cmd jsonb; sales jsonb; acts jsonb; item jsonb; result jsonb; s text; due text; target text; stamp text:=to_char(now() at time zone 'America/Boise','YYYY-MM-DD'); next_due text; activity_id text; stage text;
begin
 if uid is null then raise exception 'Sign in before saving';end if;
 if record_kind='progress' then select coalesce(record,'{}')||jsonb_build_object('status',status,'log',coalesce(log,'[]'),'followUp',coalesce(follow_up,'')) into c from public.progress where user_id=uid and school_id=record_id for update;
 elsif record_kind='leads' then select to_jsonb(l) into c from public.leads l where user_id=uid and id::text=record_id for update;
 elsif record_kind='website_inquiries' then select to_jsonb(i) into c from public.website_inquiries i where user_id=uid and id::text=record_id for update;
 else raise exception 'Unsupported record type';end if;
 if c is null then raise exception 'Record not found or access denied';end if;
 cmd:=coalesce(c->'command','{}');sales:=coalesce(cmd->'sales','{}');
 if coalesce(sales->>'revision','0') is distinct from expected_revision then raise exception 'This opportunity changed elsewhere. Reload it before saving; your edits are still here.';end if;
 s:=c->>'status';acts:=coalesce(sales->'activities','[]');
 if jsonb_typeof(acts)<>'array' then raise exception 'Invalid existing activities';end if;
 if operation like 'activity_%' then
  due:=public.crm_workflow_date(coalesce(c->>'followUp',c->>'follow_up'));
  if due<>'' and not exists(select 1 from jsonb_array_elements(acts) a where a->>'due'=due) then acts:=acts||jsonb_build_array(jsonb_build_object('id',case when exists(select 1 from jsonb_array_elements(acts) a where a->>'id'='legacy') then 'legacy:'||due else 'legacy' end,'type','email','subject','Follow up','due',due,'note','Existing CRM follow-up','createdAt',now()));end if;
  sales:=sales||jsonb_build_object('legacyImported',true);
 end if;
 case operation
 when 'promote' then if coalesce(nullif(payload->>'stage',''),'Qualified') not in ('Qualified','Contacted','Conversation','Pricing / Proposal','Decision') then raise exception 'Invalid pipeline stage';end if;sales:=sales||jsonb_build_object('inPipeline',true,'stage',coalesce(nullif(payload->>'stage',''),'Qualified'),'promotedAt',now());
 when 'stage' then
  stage:=payload->>'stage';
  if stage not in ('Qualified','Contacted','Conversation','Pricing / Proposal','Decision','Won','Lost') or stage is null then raise exception 'Invalid pipeline stage';end if;
  if s in ('Not Interested','Closed','Try Next Year') and stage<>'Lost' then raise exception 'This record is closed or deferred. Reopen it in the contact record before moving it.';end if;
  if s in ('Booked!','Booked','Completed') and stage<>'Won' then raise exception 'A booked engagement must be reopened in the contact record before moving it.';end if;
  sales:=sales||jsonb_build_object('inPipeline',true,'stage',stage,'stageChangedAt',now());
  if stage='Won' then s:=case when record_kind='progress' then 'Booked!' else 'Booked' end;
  elsif stage='Lost' then s:=case when record_kind='website_inquiries' then 'Closed' else 'Not Interested' end;cmd:=cmd||jsonb_build_object('outreachPaused',true);sales:=sales||jsonb_build_object('lostReason',coalesce(payload->>'reason',''));
  elsif stage in ('Conversation','Pricing / Proposal','Decision') and record_kind<>'website_inquiries' then s:='In Discussion';end if;
 when 'reopen' then
  if coalesce(cmd->>'doNotContact','false')='true' or coalesce(c->>'notes','') ~* 'do not contact|opt.?out|unsubscribe' then raise exception 'This contact has a do-not-contact restriction. Resolve it in the contact record before reopening.';end if;
  s:=case when record_kind='website_inquiries' then 'Contacted' else 'In Discussion' end;
  sales:=sales||jsonb_build_object('inPipeline',true,'stage','Conversation','reopenedAt',now());cmd:=cmd||jsonb_build_object('outreachPaused',false);
 when 'activity_add' then
  due:=payload->>'due';if public.crm_workflow_date(due) is distinct from due or nullif(due,'') is null then raise exception 'Choose a valid activity date';end if;
  if payload->>'type' not in ('call','email','meeting','task') or payload->>'type' is null then raise exception 'Invalid activity type';end if;
  if nullif(trim(payload->>'subject'),'') is null then raise exception 'Activity title is required';end if;
  if coalesce(payload->>'time','')<>'' and payload->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid activity time';end if;
  activity_id:=gen_random_uuid()::text;
  acts:=acts||jsonb_build_array(jsonb_build_object('id',activity_id,'type',payload->>'type','subject',left(trim(payload->>'subject'),200),'due',due,'time',coalesce(payload->>'time',''),'note',coalesce(payload->>'note',''),'createdAt',now()));
 when 'activity_done' then
  activity_id:=payload->>'id';if not exists(select 1 from jsonb_array_elements(acts) a where a->>'id'=activity_id and nullif(a->>'completedAt','') is null) then raise exception 'Activity changed or was already completed';end if;
  select coalesce(jsonb_agg(case when a->>'id'=activity_id then a||jsonb_build_object('completedAt',now()) else a end order by n),'[]') into acts from jsonb_array_elements(acts) with ordinality x(a,n);
 when 'note' then
  if nullif(trim(payload->>'text'),'') is null then raise exception 'Write a note before saving';end if;
  item:=jsonb_build_object('id',gen_random_uuid()::text,'text',trim(payload->>'text'),'createdAt',now());
  sales:=sales||jsonb_build_object('notes',coalesce(sales->'notes','[]')||jsonb_build_array(item));
 when 'details' then
  if payload ? 'value' then if (payload->>'value')<>'' and ((payload->>'value') !~ '^[0-9]+([.][0-9]{1,2})?$') then raise exception 'Enter a valid non-negative amount';end if;sales:=sales||jsonb_build_object('value',payload->>'value');cmd:=cmd||jsonb_build_object('potentialFee',payload->>'value');end if;
  if payload ? 'expectedClose' then if (payload->>'expectedClose')<>'' and public.crm_workflow_date(payload->>'expectedClose') is distinct from payload->>'expectedClose' then raise exception 'Invalid expected booking date';end if;sales:=sales||jsonb_build_object('expectedClose',payload->>'expectedClose');end if;
 else raise exception 'Unknown sales operation';end case;
 if operation like 'activity_%' then
  sales:=sales||jsonb_build_object('activities',acts);
  select min(a->>'due') into next_due from jsonb_array_elements(acts) a where nullif(a->>'completedAt','') is null;
  c:=jsonb_set(c,array[case when record_kind='progress' then 'followUp' else 'follow_up' end],to_jsonb(coalesce(next_due,'')));
 end if;
 sales:=sales||jsonb_build_object('revision',gen_random_uuid()::text,'updatedAt',now());
 cmd:=cmd||jsonb_build_object('sales',sales);c:=c||jsonb_build_object('command',cmd,'status',s);
 if record_kind='progress' then update public.progress set record=c,status=s,follow_up=case when operation like 'activity_%' then next_due else follow_up end where user_id=uid and school_id=record_id returning record into result;
 elsif record_kind='leads' then update public.leads l set command=cmd,status=s,follow_up=case when operation like 'activity_%' then next_due else l.follow_up end where user_id=uid and id::text=record_id returning to_jsonb(l) into result;
 else update public.website_inquiries i set command=cmd,status=s,follow_up=case when operation like 'activity_%' then nullif(next_due,'')::date else i.follow_up end where user_id=uid and id::text=record_id returning to_jsonb(i) into result;end if;
 insert into public.crm_activity(user_id,record_kind,record_id,event_type,event_key,details) values(uid,record_kind,record_id,'sales_'||operation,'sales:'||(sales->>'revision'),jsonb_build_object('operation',operation,'payload',payload));
 return result;
end $$;
revoke all on function public.save_crm_sales_workspace(text,text,text,text,jsonb) from public,anon;
grant execute on function public.save_crm_sales_workspace(text,text,text,text,jsonb) to authenticated;
