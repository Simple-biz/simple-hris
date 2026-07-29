-- Adds effective_date to mesa_requests: the day an opt-out takes effect — when
-- the member's ₱100 weekly contribution (and Simple's ₱300 match) should stop.
-- Employee-supplied on Employee → MESA → Request → Opt-out, where it is
-- required; null for every other request type.
-- Run once in the Supabase SQL editor. The Opt-out form POSTs this column, so
-- run it BEFORE deploying — without it, opt-out submissions fail.

ALTER TABLE mesa_requests
  ADD COLUMN IF NOT EXISTS effective_date DATE;

COMMENT ON COLUMN mesa_requests.effective_date IS
  'Opt-out only: the date the member''s MESA participation ends (weekly deduction + match stop).';
