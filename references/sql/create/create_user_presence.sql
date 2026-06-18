-- Lightweight "last seen" store for the My Team online/offline UI.
-- The realtime presence channel (`hris-presence`) is broadcast-only, so as soon
-- as a client disconnects we lose their timestamp. This table is updated by a
-- heartbeat from PresenceProvider so we can render "Last seen 5m ago" for
-- people who are not currently online.
create table if not exists public.user_presence (
  email        text         primary key,
  name         text,
  last_seen_at timestamptz  not null default now()
);

create index if not exists user_presence_last_seen_idx
  on public.user_presence (last_seen_at desc);

-- Lower-case the email on every write so lookups stay case-insensitive
-- (matches the convention used by employee_notifications, employee_feature_permissions, ...).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists user_presence_normalize_email on public.user_presence;
    create trigger user_presence_normalize_email
      before insert or update on public.user_presence
      for each row execute function public.normalize_email_column('email');
  end if;
end$$;
