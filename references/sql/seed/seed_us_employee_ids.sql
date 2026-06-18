-- ============================================================
-- Assign US-prefixed employee_ids to existing rows.
-- Format: US-{YYMM}-{NNNN}
--   YYMM = hire year/month
--   NNNN = sequence within that month (oldest hire = 0001)
--
-- Rows for these work_emails already exist in employee_ids
-- (UNIQUE constraint employee_ids_work_email_key blocks plain
-- INSERTs). We UPDATE in place, matching on work_email.
--
-- Brandon Biggs (brandonb@simple.biz) may not exist yet — the
-- final block INSERTs him only if missing.
-- ============================================================

-- ── 1. Preview what's about to change (run alone first to confirm) ──
SELECT employee_id AS old_id, name, work_email, personal_email
FROM public.employee_ids
WHERE work_email IN (
  'thomas@simple.biz', 'jeff@simple.biz', 'teal@simple.biz', 'carla@simple.biz',
  'emma@simple.biz', 'jackie@simple.biz', 'courtney@simple.biz',
  'seungyong@simple.biz', 'nicholas@simple.biz', 'sterling@simple.biz',
  'adrian@simple.biz', 'brandonb@simple.biz'
)
ORDER BY work_email;

-- ── 2. Reassign IDs ──
UPDATE public.employee_ids SET employee_id = 'US-1802-0001', name = 'Thomas Arndt',      personal_email = COALESCE(personal_email, 'tmarndt11@gmail.com')        WHERE work_email = 'thomas@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2002-0001', name = 'Jeffrey Thibodeau', personal_email = COALESCE(personal_email, 'jefft149@yahoo.com')         WHERE work_email = 'jeff@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2007-0001', name = 'Teal Lepley',       personal_email = COALESCE(personal_email, 'tclepley@ncsu.edu')          WHERE work_email = 'teal@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2104-0001', name = 'Carla Thomas',      personal_email = COALESCE(personal_email, 'carlathomas0112@gmail.com')  WHERE work_email = 'carla@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2108-0001', name = 'Emma Kitson',       personal_email = COALESCE(personal_email, 'emmakitson@gmail.com')       WHERE work_email = 'emma@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2110-0001', name = 'Jaquelin Zapata',   personal_email = COALESCE(personal_email, 'zapatajaquelin@icloud.com')  WHERE work_email = 'jackie@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2110-0002', name = 'Courtney Andresen', personal_email = COALESCE(personal_email, 'cdandresen13@gmail.com')     WHERE work_email = 'courtney@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2111-0001', name = 'Seungyong Lee'                                                                                  WHERE work_email = 'seungyong@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2112-0001', name = 'Nicholas Charland', personal_email = COALESCE(personal_email, 'nickccharland@gmail.com')     WHERE work_email = 'nicholas@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2209-0001', name = 'Sterling Foote',    personal_email = COALESCE(personal_email, 'sterlinghfoote@gmail.com')    WHERE work_email = 'sterling@simple.biz';
UPDATE public.employee_ids SET employee_id = 'US-2509-0001', name = 'Adrian Fierro'                                                                                  WHERE work_email = 'adrian@simple.biz';

-- Brandon Biggs is a new hire — INSERT only if no row yet.
INSERT INTO public.employee_ids (employee_id, name, work_email, personal_email)
SELECT 'US-2604-0001', 'Brandon Biggs', 'brandonb@simple.biz', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.employee_ids WHERE work_email = 'brandonb@simple.biz'
);
-- If a row already exists for brandonb@, fall back to UPDATE:
UPDATE public.employee_ids SET employee_id = 'US-2604-0001', name = 'Brandon Biggs'
WHERE work_email = 'brandonb@simple.biz' AND employee_id <> 'US-2604-0001';

-- ── 3. Verify ──
SELECT employee_id, name, work_email, personal_email
FROM public.employee_ids
WHERE employee_id LIKE 'US-%'
ORDER BY employee_id;
