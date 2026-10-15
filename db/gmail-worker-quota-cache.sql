-- Cache immutable Gmail SENT metadata, not bodies or credentials, to avoid repeated API reads.
create table public.gmail_worker_sent_cache (
 user_id uuid not null references auth.users(id),message_id text not null,sent_at timestamptz not null,gmail_metadata jsonb not null,
 primary key(user_id,message_id)
);
create index gmail_worker_sent_cache_date_idx on public.gmail_worker_sent_cache(user_id,sent_at);
alter table public.gmail_worker_sent_cache enable row level security;
revoke all on public.gmail_worker_sent_cache from public,anon,authenticated;
grant select,insert,update,delete on public.gmail_worker_sent_cache to service_role;
