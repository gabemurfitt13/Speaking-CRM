-- Transaction-tested and applied October 13, 2026.
-- No sends or automatic retries; old claim evidence is preserved.
create or replace function public.expire_unconfirmed_outreach_claims(p_user_id uuid)
returns setof public.outreach_queue language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is distinct from p_user_id and coalesce(auth.jwt()->>'role','')<>'service_role' and current_user<>'postgres' then raise exception 'Unauthorized';end if;
 return query update public.outreach_queue q set status='held',
 hold_reason=concat('Expired unconfirmed sender claim; reconcile Gmail and worker ownership before any retry. Claimed at ',q.claimed_at::text,'. Previous hold: ',coalesce(q.hold_reason,'')),
 updated_at=now()
 where q.user_id=p_user_id and q.status='sending' and q.claimed_at is not null and greatest(q.claimed_at,q.updated_at)<now()-interval '15 minutes'
 returning q.*;
end; $$;
revoke all on function public.expire_unconfirmed_outreach_claims(uuid) from public,anon;
grant execute on function public.expire_unconfirmed_outreach_claims(uuid) to authenticated,service_role;