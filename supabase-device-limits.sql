create table if not exists public.simplit_usage_limits (
  usage_date date not null,
  identity_type text not null check (identity_type in ('user', 'device')),
  identity_id text not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (usage_date, identity_type, identity_id)
);

alter table public.simplit_usage_limits enable row level security;

drop policy if exists "Backend service role can manage usage limits" on public.simplit_usage_limits;
create policy "Backend service role can manage usage limits"
on public.simplit_usage_limits
for all
to service_role
using (true)
with check (true);
