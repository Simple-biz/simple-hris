-- Migration: apparel_size column on employee_gift_shipping_details
-- Created: 2026-07-14
--
-- Tenure gifts are informational now (no payment / no price) — the one piece of
-- info the team needs from the employee is their apparel size, since several
-- milestone gifts are wearables (Tshirt, Hoodie, Jacket, Polo, Hat). Non-apparel
-- milestones (Tumbler, Mug, Speaker, …) simply leave it blank.
--
-- Collected on the Employee Dashboard gift form alongside the delivery details.
--
-- Idempotent: rerunning is safe.

BEGIN;

ALTER TABLE public.employee_gift_shipping_details
  ADD COLUMN IF NOT EXISTS apparel_size TEXT NOT NULL DEFAULT '';

COMMIT;
