create or replace function public.moderate_crm_inquiry(inquiry_id uuid, action text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.website_inquiries; m jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in before saving';end if;
 if action not in ('spam','trash','restore') or action is null then raise exception 'Invalid action';end if;
 select * into r from public.website_inquiries where id=inquiry_id and user_id=auth.uid() for update;
 if not found then raise exception 'Inquiry not found or access denied';end if;
 m:=coalesce(r.command->'crmModeration','{}');
 if action='restore' then
  update public.website_inquiries set status=coalesce(m->>'previousStatus','New'),follow_up=nullif(m->>'previousFollowUp','')::date,command=coalesce(command,'{}')-'crmModeration' where id=r.id and user_id=auth.uid() returning * into r;
 else
  if m->>'state' is null then m:=jsonb_build_object('previousStatus',r.status,'previousFollowUp',r.follow_up);end if;
  m:=m||jsonb_build_object('state',action,'changedAt',now());
  update public.website_inquiries set status='Closed',follow_up=null,command=coalesce(command,'{}')||jsonb_build_object('crmModeration',m) where id=r.id and user_id=auth.uid() returning * into r;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.moderate_crm_inquiry(uuid,text) from public,anon;
grant execute on function public.moderate_crm_inquiry(uuid,text) to authenticated;
