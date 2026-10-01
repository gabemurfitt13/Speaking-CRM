-- Preserve market/source snapshots and pricing milestones in future history.
create or replace function public.capture_crm_activity() returns trigger language plpgsql security invoker set search_path='' as $$
declare n jsonb:=to_jsonb(new); o jsonb:='{}'; rid text; entry jsonb; oldlogs jsonb; oldcmd jsonb; cmd jsonb;
begin
 if tg_op='UPDATE' then o:=to_jsonb(old); end if;
 rid:=coalesce(n->>'school_id',n->>'id');
 cmd:=case when tg_table_name='progress' then coalesce(n->'record'->'command','{}') else coalesce(n->'command','{}') end;
 oldcmd:=case when tg_table_name='progress' then coalesce(o->'record'->'command','{}') else coalesce(o->'command','{}') end;
 if tg_op='INSERT' then
  insert into public.crm_activity(user_id,record_kind,record_id,event_type,details) values(new.user_id,tg_table_name,rid,'created',jsonb_build_object('market',cmd->>'market'));
 end if;
 if n->>'status' is distinct from o->>'status' then
  insert into public.crm_activity(user_id,record_kind,record_id,event_type,details) values(new.user_id,tg_table_name,rid,'status',jsonb_build_object('from',o->>'status','to',n->>'status','fee',n->>'fee','command',cmd));
 end if;
 if cmd->>'stage' is distinct from oldcmd->>'stage' or cmd->>'qualified' is distinct from oldcmd->>'qualified' or cmd->>'pricingRequested' is distinct from oldcmd->>'pricingRequested' then
  insert into public.crm_activity(user_id,record_kind,record_id,event_type,details) values(new.user_id,tg_table_name,rid,'milestone',jsonb_build_object('stage',cmd->>'stage','fromStage',oldcmd->>'stage','previousPricingRequested',oldcmd->>'pricingRequested','qualified',cmd->>'qualified','pricingRequested',cmd->>'pricingRequested','market',cmd->>'market','source',cmd->>'source'));
 end if;
 oldlogs:=coalesce(o->'log','[]');
 for entry in select value from jsonb_array_elements(coalesce(n->'log','[]')) loop
  if not oldlogs @> jsonb_build_array(entry) then
   insert into public.crm_activity(user_id,record_kind,record_id,event_type,event_key,details)
    values(new.user_id,tg_table_name,rid,'log','log:'||md5(entry::text),entry || jsonb_build_object('snapshot',cmd)) on conflict do nothing;
  end if;
 end loop;
 return new;
end $$;
