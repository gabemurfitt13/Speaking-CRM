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
