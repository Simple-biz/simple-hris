-- Contractor invoices: attach a chosen payment rail (how Accounting should pay).
-- Stored as JSONB, e.g.
--   Global: {"region":"global","processor":"hurupay","fields":{"email":"you@x.com"}}
--   US:     {"region":"us","processor":"ach","fields":{"accountHolder":"John Smith",
--            "bankName":"Chase","accountNumber":"000123456789","routingNumber":"021000021",
--            "accountType":"Checking"}}
ALTER TABLE contractor_invoices ADD COLUMN IF NOT EXISTS payment_method JSONB;
