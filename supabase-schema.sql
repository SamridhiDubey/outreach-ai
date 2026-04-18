-- Run this in your Supabase project: SQL Editor > New query

-- Events table: one row per generation attempt
create table if not exists events (
  id          bigserial primary key,
  user_id     text        not null,
  tone        text,
  success     boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- Index for fast unique-user counts and time-range queries
create index if not exists events_user_id_idx    on events (user_id);
create index if not exists events_created_at_idx on events (created_at);

-- Milestones table: one row per triggered milestone (prevents re-firing)
create table if not exists milestones (
  id         bigserial primary key,
  name       text        not null unique,  -- "10", "50", "100", etc.
  created_at timestamptz not null default now()
);

-- Row Level Security: service role key bypasses RLS, so just enable it
-- to block any accidental anon/public access.
alter table events    enable row level security;
alter table milestones enable row level security;
