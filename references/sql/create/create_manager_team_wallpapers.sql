-- Per-department "My Team" wallpaper banner. One row per department; the
-- image is stored inline as a data URL so there's no Supabase Storage bucket
-- to provision. Capped at ~10 MB by the API (~13 MB base64 in TEXT).
create table if not exists public.manager_team_wallpapers (
  department          text         primary key,
  image_data_url      text         not null,
  background_position text         not null default '50% 50%',
  updated_by          text,
  updated_at          timestamptz  not null default now()
);

-- Idempotent ALTER for environments where the table was created before the
-- background_position column existed.
alter table public.manager_team_wallpapers
  add column if not exists background_position text not null default '50% 50%';

create index if not exists manager_team_wallpapers_dept_lower_idx
  on public.manager_team_wallpapers (lower(department));
