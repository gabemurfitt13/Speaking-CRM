-- Applied and transaction-tested in project hoyilsqwbdkbxismiatf on 2026-10-13.
-- These triggers never send email or grant approval. They preserve source notes.
create or replace function public.sync_confirmed_initial_queue_send() returns trigger language plpgsql security invoker set search_path='' as $$
declare p public.progress%rowtype; entry jsonb; entries jsonb; day text;
begin
 if new.kind<>'initial' or new.status<>'sent' or nullif(trim(new.provider_message_id),'') is null or new.sent_at is null then return new; end if;
 select * into p from public.progress where user_id=new.user_id and school_id=new.school_id for update;
 if not found or lower(trim(coalesce(p.email,'')))<>lower(trim(new.verified_email)) then return new; end if;
 day:=to_char(new.sent_at at time zone 'America/Boise','YYYY-MM-DD');
 entries:=case when jsonb_typeof(p.log)='array' then p.log else '[]'::jsonb end;
 if not exists(select 1 from jsonb_array_elements(entries) e where coalesce(e->>'gmailMessageId',e->>'providerMessageId',e->>'resendId')=new.provider_message_id) then
 entry:=jsonb_build_object('type','Email sent','date',day,'timestamp',new.sent_at,'recipient',new.verified_email,'subject',new.approved_subject,'providerMessageId',new.provider_message_id,'queueId',new.id,'note','Confirmed send recorded in outreach queue; provider acceptance, not proof of inbox delivery.');
 entries:=entries||jsonb_build_array(entry);
 end if;
 update public.progress set status=case when status='Not Started' then 'Emailed' else status end,contacted=case when coalesce(contacted,'')='' then day else contacted end,log=entries,
 record=coalesce(record,'{}'::jsonb)||jsonb_build_object('status',case when p.status='Not Started' then 'Emailed' else p.status end,'contacted',case when coalesce(p.contacted,'')='' then day else p.contacted end,'log',entries)
 where user_id=new.user_id and school_id=new.school_id;
 return new;
end; $$;
revoke all on function public.sync_confirmed_initial_queue_send() from public,anon,authenticated;
create trigger sync_confirmed_initial_queue_send after insert or update of status,provider_message_id,sent_at on public.outreach_queue for each row execute function public.sync_confirmed_initial_queue_send();

create or replace function public.protect_completed_outreach() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.status='sent' and new.status<>'sent' then raise exception 'Confirmed sent outreach cannot be reopened; reconcile a distinct correspondence separately'; end if;
 if old.status='sent' and nullif(trim(old.provider_message_id),'') is not null and (new.provider_message_id is distinct from old.provider_message_id or new.verified_email is distinct from old.verified_email) then raise exception 'Confirmed send identity is immutable'; end if;
 return new;
end; $$;
revoke all on function public.protect_completed_outreach() from public,anon,authenticated;
create trigger protect_completed_outreach before update on public.outreach_queue for each row execute function public.protect_completed_outreach();