alter table public.ai_actions
 add column if not exists ai_status text not null default 'not_started' check (ai_status in ('not_started','working','ready','failed')),
 add column if not exists ai_output jsonb not null default '{}'::jsonb,
 add column if not exists ai_model text,
 add column if not exists ai_prepared_at timestamptz;
create index if not exists ai_actions_owner_ai_status on public.ai_actions(user_id,ai_status);