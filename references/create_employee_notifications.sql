-- Employee notifications: per-employee message feed surfaced in NotificationsPanel.
-- Reserved for events the employee should be told about directly (rate changes,
-- future promotion w/ title change, etc).
create table if not exists public.employee_notifications (
  id              uuid         primary key default gen_random_uuid(),
  recipient_email text         not null,
  type            text         not null check (type in ('rate.change','promotion')),
  tone            text         not null check (tone in ('positive','neutral')) default 'neutral',
  title           text         not null,
  message         text         not null,
  details         jsonb        not null default '{}'::jsonb,
  read_at         timestamptz,
  created_at      timestamptz  not null default now()
);

create index if not exists employee_notifications_recipient_idx
  on public.employee_notifications (lower(recipient_email), created_at desc);
create index if not exists employee_notifications_unread_idx
  on public.employee_notifications (lower(recipient_email))
  where read_at is null;

-- Lower-case recipient_email on write so lookups stay case-insensitive.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists employee_notifications_normalize_email on public.employee_notifications;
    create trigger employee_notifications_normalize_email
      before insert or update on public.employee_notifications
      for each row execute function public.normalize_email_column('recipient_email');
  end if;
end$$;

-- Expose to Realtime so the panel can subscribe to inserts.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.employee_notifications;
    exception when duplicate_object then
      null;
    end;
  end if;
end$$;
