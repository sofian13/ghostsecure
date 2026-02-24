-- Ghost Secure patch: add call invite + realtime + permissions
-- Safe to run multiple times

-- 1) Core tables (if missing)
create table if not exists public.app_user (
  id text primary key,
  public_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation (
  id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_member (
  id bigint generated always as identity primary key,
  conversation_id text not null references public.conversation(id) on delete cascade,
  user_id text not null references public.app_user(id) on delete cascade,
  unique (conversation_id, user_id)
);

create table if not exists public.friend_request (
  id text primary key,
  requester_id text not null references public.app_user(id) on delete cascade,
  target_user_id text not null references public.app_user(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.message (
  id text primary key,
  conversation_id text not null references public.conversation(id) on delete cascade,
  sender_id text not null references public.app_user(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  wrapped_keys jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz null
);

-- 2) NEW: persistent call signaling
create table if not exists public.call_invite (
  id text primary key,
  call_id text not null unique,
  from_user_id text not null references public.app_user(id) on delete cascade,
  target_user_id text not null references public.app_user(id) on delete cascade,
  offer_sdp jsonb not null,
  answer_sdp jsonb null,
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Indexes
create index if not exists idx_cm_conversation on public.conversation_member(conversation_id);
create index if not exists idx_cm_user on public.conversation_member(user_id);

create index if not exists idx_msg_conv_created on public.message(conversation_id, created_at);
create index if not exists idx_msg_sender on public.message(sender_id);

create index if not exists idx_fr_target_status on public.friend_request(target_user_id, status, created_at desc);
create index if not exists idx_fr_requester_status on public.friend_request(requester_id, status, created_at desc);

create unique index if not exists uniq_fr_pending_pair
  on public.friend_request(requester_id, target_user_id)
  where status = 'pending';

create index if not exists idx_call_invite_target_status
  on public.call_invite(target_user_id, status, created_at desc);

create index if not exists idx_call_invite_from_status
  on public.call_invite(from_user_id, status, created_at desc);

-- 4) Realtime publication (idempotent)
do $$
begin
  alter publication supabase_realtime add table public.message;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.friend_request;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.call_invite;
exception when duplicate_object then null;
end $$;

-- 5) RLS disabled for current app model
alter table public.app_user disable row level security;
alter table public.conversation disable row level security;
alter table public.conversation_member disable row level security;
alter table public.friend_request disable row level security;
alter table public.message disable row level security;
alter table public.call_invite disable row level security;

-- 6) Grants for anon/authenticated (frontend direct supabase-js)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

alter default privileges in schema public
grant select, insert, update, delete on tables to anon, authenticated;

alter default privileges in schema public
grant usage, select on sequences to anon, authenticated;
