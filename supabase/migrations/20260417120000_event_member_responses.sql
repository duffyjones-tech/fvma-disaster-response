-- Member check-in responses for a disaster event (one row per member per event).
-- Apply in Supabase SQL Editor or via supabase db push.

create table if not exists public.event_member_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_id uuid not null references public.events (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  status text not null check (status in ('safe', 'needs_help')),
  channel text check (channel in ('email', 'sms', 'voice', 'web')),
  responded_at timestamptz not null default now(),
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, member_id)
);

create index if not exists event_member_responses_event_org_idx
  on public.event_member_responses (event_id, organization_id);

create index if not exists event_member_responses_member_idx
  on public.event_member_responses (member_id);
