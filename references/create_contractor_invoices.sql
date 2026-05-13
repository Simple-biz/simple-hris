-- Contractor invoices table
-- Note: "from_company" is stored as "from_entity_name" to match the UI label "Entity Name"
CREATE TABLE IF NOT EXISTS contractor_invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_email    TEXT NOT NULL,

  invoice_number      TEXT NOT NULL,
  invoice_date        DATE,
  due_date            DATE,

  -- From (contractor)
  from_entity_name    TEXT,
  from_name           TEXT,
  from_address        TEXT,
  from_city_state_zip TEXT,
  from_country        TEXT DEFAULT 'Philippines',

  -- Bill To (always Simple.biz — stored for record-keeping)
  to_company          TEXT DEFAULT 'Simple.biz',
  to_address          TEXT DEFAULT 'Remote/USA',
  to_city_state_zip   TEXT,
  to_country          TEXT DEFAULT 'USA',

  -- Line items as JSONB array: [{id, description, notes, qty, rate, taxPct}]
  line_items          JSONB NOT NULL DEFAULT '[]',
  notes               TEXT,

  -- Computed totals (stored for quick display)
  subtotal            NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total               NUMERIC(12,2) NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contractor_invoices_email_idx ON contractor_invoices (contractor_email);
CREATE INDEX IF NOT EXISTS contractor_invoices_created_at_idx ON contractor_invoices (created_at DESC);
