-- Prevent duplicate initial recipient claims across prospect records and direct sending inserts.
-- Deployed October 13, 2026. Rollback tests passed before and after deployment:
-- sent/held/inflight duplicate claims rejected, distinct approved claim passed,
-- direct initial sending INSERT rejected; zero QA fixtures persisted.
CREATE OR REPLACE FUNCTION public.guard_initial_outreach_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare is_school boolean; daily_count integer; hourly_count integer; recipient_tz text; spread text; enforce_spread boolean; day_start timestamptz; domain text;
begin
 if old.status='sending' and new.status in ('ready','scheduled') then raise exception 'Unconfirmed in-flight outreach must be reconciled, not reopened';end if;
 if new.kind<>'initial' or new.status<>'sending' or old.status='sending' then return new; end if;
 if old.status not in ('ready','scheduled') then raise exception 'Initial outreach must be approved and ready, not held';end if;
 if old.status='scheduled' and (old.scheduled_at is null or old.scheduled_at>now()) then raise exception 'Initial outreach not-before date has not arrived';end if;
 if old.status='ready' and nullif(trim(old.hold_reason),'') is not null then raise exception 'Active initial outreach hold';end if;
 if nullif(trim(new.approved_subject),'') is null or nullif(trim(new.approved_body),'') is null then raise exception 'Reviewed initial draft required';end if;
 if not exists(select 1 from public.crm_activity a where a.user_id=new.user_id and a.record_id=new.school_id and a.event_type='initial_outreach_approved' and a.details->>'recipient'=new.verified_email and a.details->>'subject'=new.approved_subject and a.details->>'body'=new.approved_body) then raise exception 'Matching initial outreach approval required';end if;
 if not exists(select 1 from public.progress p where p.user_id=new.user_id and p.school_id=new.school_id and p.status='Not Started' and lower(trim(p.email))=lower(trim(new.verified_email)) and p.contact_confidence in ('high','verified') and nullif(trim(p.last_verified),'') is not null and nullif(trim(p.contact_source),'') is not null) then raise exception 'Verified uncontacted prospect required';end if;
 if extract(isodow from now() at time zone 'America/Boise') not between 1 and 5 or (now() at time zone 'America/Boise')::time<'09:00' or (now() at time zone 'America/Boise')::time>='15:00' then raise exception 'Outside authorized Boise sending hours';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,0));
 if exists(select 1 from public.outreach_queue q where q.user_id=new.user_id and q.id<>new.id and q.kind='initial' and lower(trim(q.verified_email))=lower(trim(new.verified_email)) and (q.status in ('sending','held') or (q.status='sent' and q.provider_message_id is not null))) then raise exception 'Recipient already sent, held, or claimed on another initial record';end if;
 is_school:=new.school_id !~ '^(biz-|church-|college-|conf-)';
 day_start:=date_trunc('day',now() at time zone 'America/Boise') at time zone 'America/Boise';
 select count(*) into daily_count from public.outreach_queue q where q.user_id=new.user_id and q.kind='initial' and (q.school_id !~ '^(biz-|church-|college-|conf-)')=is_school and ((q.status='sent' and q.sent_at>=day_start) or q.status='sending');
 if daily_count>=(case when is_school then 270 else 50 end) then raise exception 'Initial daily sending ceiling reached';end if;
 if is_school then
 select count(*) into hourly_count from public.outreach_queue q where q.user_id=new.user_id and q.kind='initial' and q.school_id !~ '^(biz-|church-|college-|conf-)' and ((q.status='sent' and q.sent_at>=now()-interval '1 hour') or q.status='sending');
 if hourly_count>=45 then raise exception 'School hourly sending ceiling reached';end if;
 end if;
 if is_school then
 select split_part(lower(trim(p.email)),'@',2),
 lower(coalesce(p.record->'command'->>'spreadGroup',(regexp_match(p.notes,'spreadGroup[[:space:]=:]+([A-Za-z0-9_-]+)','i'))[1])),
 coalesce(p.notes,'') ~* 'do not send to more than one school.*district per day'
 into domain,spread,enforce_spread from public.progress p where p.user_id=new.user_id and p.school_id=new.school_id;
 if enforce_spread and exists(select 1 from public.outreach_queue q left join public.progress p on p.user_id=q.user_id and p.school_id=q.school_id where q.user_id=new.user_id and q.id<>new.id and q.kind='initial' and q.school_id !~ '^(biz-|church-|college-|conf-)' and ((q.status='sent' and q.sent_at>=day_start) or q.status='sending') and (split_part(lower(trim(q.verified_email)),'@',2)=domain or (spread is not null and lower(coalesce(p.record->'command'->>'spreadGroup',(regexp_match(p.notes,'spreadGroup[[:space:]=:]+([A-Za-z0-9_-]+)','i'))[1]))=spread))) then raise exception 'District daily spreading limit reached';end if;
 end if;
 -- Gmail all-account counts, recipient hours, district spreads, suppressions and mailbox duplicates remain mandatory sender preflight.
 return new;
end; $function$;
CREATE OR REPLACE FUNCTION public.reject_direct_initial_send_claim() RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$ BEGIN IF NEW.kind='initial' AND NEW.status='sending' THEN RAISE EXCEPTION 'Initial outreach must be inserted ready and claimed through preflight checks'; END IF; RETURN NEW; END; $function$;
REVOKE ALL ON FUNCTION public.reject_direct_initial_send_claim() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER reject_direct_initial_send_claim BEFORE INSERT ON public.outreach_queue FOR EACH ROW EXECUTE FUNCTION public.reject_direct_initial_send_claim();