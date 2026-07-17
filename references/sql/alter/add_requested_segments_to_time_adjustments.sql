-- Time Adjustment Requests: requested time segments (2026-07-17)
-- Employees now point at the exact MISSED time in / time out ranges (the untracked
-- stretches to be ADDED on top of tracked hours) instead of entering a bare total.
-- Stored as a jsonb array of segments:
--   [{ "time_in": "09:00", "time_out": "10:00" }, ...]   (24h HH:MM, day-local)
-- requested_hours is computed server-side as the sum of the segments = the hours
-- claimed to be missing. NOTE: this changes the meaning of requested_hours for new
-- rows (was "claimed day total"); approved_hours stays a SET override of the full
-- day, so Accounting sets tracked + missed when approving.
--
-- Run once against Supabase.

alter table public.time_adjustment_requests
  add column if not exists requested_segments jsonb not null default '[]'::jsonb;

comment on column public.time_adjustment_requests.requested_segments is
  'Missed (untracked) time in/out ranges to add: [{time_in:"HH:MM",time_out:"HH:MM"}]. requested_hours = sum of segments.';
