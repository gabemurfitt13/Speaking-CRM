-- Connection storage only. No schedule, sender, or outreach approval is changed.
create table public.gmail_oauth_states (
 state_hash text primary key check (length(state_hash)=43),
 user_id uuid not null references auth.users(id) on delete cascade,
 verifier_encrypted jsonb not null,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index gmail_oauth_states_expiry_idx on public.gmail_oauth_states(expires_at);
create table public.gmail_connections (
 user_id uuid primary key references auth.users(id) on delete cascade,
 mailbox text not null check (mailbox='gabemurfittspeaker@gmail.com'),
 refresh_token_encrypted jsonb not null,
 granted_scopes text[] not null,
 status text not null check (status in ('connected','reauthorization_required','disconnected')),
 connected_at timestamptz not null,
 last_verified_at timestamptz not null
);
alter table public.gmail_oauth_states enable row level security;
alter table public.gmail_connections enable row level security;
revoke all on public.gmail_oauth_states, public.gmail_connections from public, anon, authenticated;
grant select, insert, update, delete on public.gmail_oauth_states, public.gmail_connections to service_role;
comment on table public.gmail_connections is 'Service-role-only offline Gmail credentials, AES-GCM encrypted with HKDF-derived service-role key. Service-role key rotation requires reconnecting Gmail. Never expose tokens to the browser.';
