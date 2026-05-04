-- =============================================================================
-- S-Wall (Simple Wall) — company social feed tables
-- Run in Supabase SQL editor
-- =============================================================================

-- 1. Posts
create table if not exists swall_posts (
  id          uuid        primary key default gen_random_uuid(),
  author_email text       not null,
  author_name  text,
  body         text       not null,
  created_at   timestamptz not null default now()
);

-- 2. Reactions  (unique per user per post per emoji)
create table if not exists swall_reactions (
  id          uuid        primary key default gen_random_uuid(),
  post_id     uuid        not null references swall_posts(id) on delete cascade,
  user_email  text        not null,
  emoji       text        not null check (emoji in ('👍','❤️','😂','🔥','😮','👏')),
  created_at  timestamptz not null default now(),
  unique(post_id, user_email, emoji)
);

-- 3. Comments
create table if not exists swall_comments (
  id          uuid        primary key default gen_random_uuid(),
  post_id     uuid        not null references swall_posts(id) on delete cascade,
  author_email text       not null,
  author_name  text,
  body         text       not null,
  created_at   timestamptz not null default now()
);

-- RLS — everyone reads, API enforces writes
alter table swall_posts     enable row level security;
alter table swall_reactions enable row level security;
alter table swall_comments  enable row level security;

drop policy if exists "swall_posts_read"      on swall_posts;
drop policy if exists "swall_reactions_read"  on swall_reactions;
drop policy if exists "swall_comments_read"   on swall_comments;
drop policy if exists "swall_posts_write"     on swall_posts;
drop policy if exists "swall_reactions_write" on swall_reactions;
drop policy if exists "swall_comments_write"  on swall_comments;

create policy "swall_posts_read"      on swall_posts     for select using (true);
create policy "swall_reactions_read"  on swall_reactions for select using (true);
create policy "swall_comments_read"   on swall_comments  for select using (true);
create policy "swall_posts_write"     on swall_posts     for all    with check (true);
create policy "swall_reactions_write" on swall_reactions for all    with check (true);
create policy "swall_comments_write"  on swall_comments  for all    with check (true);

-- Enable Realtime
alter publication supabase_realtime add table swall_posts;
alter publication supabase_realtime add table swall_reactions;
alter publication supabase_realtime add table swall_comments;
