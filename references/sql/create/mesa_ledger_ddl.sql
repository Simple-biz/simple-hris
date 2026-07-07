CREATE TABLE IF NOT EXISTS mesa_ledger (
  id                        integer       PRIMARY KEY,   -- source export id
  fpu_completion_date       date,
  opt_in_number             text,
  optin_confirmation_sent   date,
  last_eligibility_notice   date,
  status                    text,          -- 'Active' | 'Inactive' | NULL
  inactive_payroll_notified date,
  email                     text,
  name                      text,
  department                text,
  additional_notes          text,
  deposit_date              date,
  worker_contribution_php   numeric(12,2),
  simple_match_php          numeric(12,2),
  total_daily_deposit_php   numeric(12,2),
  disbursement_date         date,
  disbursement_amount_php   numeric(12,2),
  disbursement_type         text,
  last_disbursement_date    date,
  receipts_deadline         date,
  receipts_received_date    date,
  funds_returned_x1153      date,
  funds_returned_mesa       date,
  notes                     text,
  synced_at                 timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mesa_ledger_email_idx        ON mesa_ledger (lower(email));
CREATE INDEX IF NOT EXISTS mesa_ledger_deposit_date_idx ON mesa_ledger (deposit_date);
CREATE INDEX IF NOT EXISTS mesa_ledger_disb_date_idx    ON mesa_ledger (disbursement_date);
CREATE INDEX IF NOT EXISTS mesa_ledger_status_idx       ON mesa_ledger (status);
