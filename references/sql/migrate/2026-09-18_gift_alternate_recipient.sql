-- [GIFT-ALT-RECIPIENT]
-- Alternate gift recipient on `employee_gift_shipping_details`
-- Created: 2026-09-18.
--
-- Some employees have somebody else — in practice a spouse — receive their
-- tenure gift for them. Until now the only place to say so was the free-text
-- Notes box, whose placeholder has literally read "alternative recipient" since
-- the form shipped. Three structured columns so the shipping list can say who
-- is at the door.
--
-- WHAT THE COURIER DOES IS UNCHANGED, AND THAT IS KANE'S RULING (2026-09-18):
--   "The Employees as they will contact their spouse."
-- `active_contact_number` still means THE EMPLOYEE'S NUMBER — the number the
-- courier calls — and `recipient_contact` is an ADDITIONAL fallback that must
-- never substitute for it. The Gift Tracker export's `Contact Number` column is
-- untouched for the same reason, and a unit test pins it.
--
-- WHAT THIS DOES NOT DO: nothing here records who actually SIGNED for a parcel.
-- That is fulfilment, it lives in `employee_gift_receipts`, and submitting an
-- address is still not receiving a gift
-- (docs/features/gift-address-external-link.md).
--
-- NO BACKFILL, EVER. Live rows hold prose naming spouses in `notes`. It is not
-- parsed and not migrated: guessing intent out of free text redirects real
-- parcels on a regex. Those rows keep their notes and read as "the employee
-- receives it", which is the honest answer until somebody restates it.
--
-- NO `BEGIN` / `COMMIT` IN THIS FILE, DELIBERATELY. The apply script opens the
-- transaction and rolls it back on a dry run; a COMMIT here would end that
-- transaction from the inside, so the rehearsal would commit to production and
-- the script's own ROLLBACK would have nothing to undo. That happened on
-- 2026-09-11 with the gift-receipts migration. Every sibling under
-- references/sql/migrate/ omits them.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.employee_gift_shipping_details
  -- NOT NULL DEFAULT '' rather than nullable: '' means "the employee receives
  -- it", which is true of every one of the existing rows. A nullable column
  -- would make "nobody said" representable both as NULL and as '', and the two
  -- would drift — the same reasoning that made `employee_gift_receipts.received`
  -- BOOLEAN NOT NULL.
  ADD COLUMN IF NOT EXISTS recipient_name         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recipient_relationship TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recipient_contact      TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN public.employee_gift_shipping_details.recipient_name IS
  'Alternate person receiving this gift on the employee''s behalf. Blank means the employee receives it themself. Never inferred from notes.';
COMMENT ON COLUMN public.employee_gift_shipping_details.recipient_relationship IS
  'How the alternate recipient relates to the employee. Closed list, mirrored in src/lib/gift-tracker/alternate-recipient.ts. Blank only when recipient_name is blank.';
COMMENT ON COLUMN public.employee_gift_shipping_details.recipient_contact IS
  'The alternate recipient''s own number. A FALLBACK ONLY — active_contact_number stays the number the courier calls (Kane, 2026-09-18).';

-- ---------------------------------------------------------------------------
-- Constraints
--
-- Dropped and recreated rather than IF NOT EXISTS: ADD CONSTRAINT has no such
-- clause, and a re-run must not fail on an already-present constraint.
-- ---------------------------------------------------------------------------

-- All three blank, or a name AND a relationship. A relationship or a phone
-- number with nobody's name on it is a parcel the courier cannot hand over —
-- the partial record is the failure this closes, and it is unrepresentable
-- rather than merely discouraged.
--
-- btrim() throughout: without it '   ' satisfies <> '' and a whitespace-only
-- name would read as "somebody else receives this" everywhere downstream.
ALTER TABLE public.employee_gift_shipping_details
  DROP CONSTRAINT IF EXISTS egsd_recipient_all_or_nothing;
ALTER TABLE public.employee_gift_shipping_details
  ADD CONSTRAINT egsd_recipient_all_or_nothing CHECK (
    (
      btrim(recipient_name) = ''
      AND btrim(recipient_relationship) = ''
      AND btrim(recipient_contact) = ''
    )
    OR (
      btrim(recipient_name) <> ''
      AND btrim(recipient_relationship) <> ''
    )
  );

-- The closed list, kept in step with GIFT_RECIPIENT_RELATIONSHIPS in
-- src/lib/gift-tracker/alternate-recipient.ts. An unknown value is REFUSED, not
-- coerced to blank — the same trade the apparel size makes, and for the same
-- reason: a silently dropped value means the parcel is handed to the wrong
-- person and nobody ever finds out why.
ALTER TABLE public.employee_gift_shipping_details
  DROP CONSTRAINT IF EXISTS egsd_recipient_relationship_known;
ALTER TABLE public.employee_gift_shipping_details
  ADD CONSTRAINT egsd_recipient_relationship_known CHECK (
    btrim(recipient_relationship) IN (
      '', 'Spouse', 'Partner', 'Parent', 'Sibling', 'Child', 'Relative',
      'Housemate', 'Friend', 'Colleague', 'Other'
    )
  );

-- Mirrors the route limits (120 / 60) so a direct database write cannot store
-- what the application would refuse. A column the app validates but the schema
-- does not is a guard with one door left open.
ALTER TABLE public.employee_gift_shipping_details
  DROP CONSTRAINT IF EXISTS egsd_recipient_lengths;
ALTER TABLE public.employee_gift_shipping_details
  ADD CONSTRAINT egsd_recipient_lengths CHECK (
    char_length(recipient_name) <= 120
    AND char_length(recipient_contact) <= 60
  );

-- Partial index: the Gift Tracker and the shipping list only ever ask "which of
-- these go to somebody else", never "which go to the employee". Indexing the
-- blank majority would be dead weight on a 1,300-row table.
CREATE INDEX IF NOT EXISTS idx_egsd_alternate_recipient
  ON public.employee_gift_shipping_details (personal_email)
  WHERE btrim(recipient_name) <> '';
