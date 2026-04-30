-- ============================================================
-- Seed: 12 US employees into global_master_list so they show up
--       in the active_employees view (and therefore the
--       accounting dashboard at /api/employees).
--
-- Departments mirror references/seed_dept_column.sql:
--   Hogan Smith Law  — courtney, thomas, nicholas, adrian, sterling, emma
--   US Manager Bonus — seungyong, jeff, carla, jackie
--   HR               — teal
--   ⚠ Brandon Biggs has no documented department yet — defaulted
--     to Hogan Smith Law. UPDATE if wrong before going live.
--
-- Each row is tagged with the CURRENT master_list_uploads id so
-- it appears in active_employees immediately. WHERE NOT EXISTS
-- on Work Email keeps this idempotent.
-- ============================================================

WITH curr AS (
  SELECT id FROM public.master_list_uploads WHERE is_current = true LIMIT 1
),
us_employees(dept, nm, pers, work, start_date) AS (VALUES
  ('Hogan Smith Law',  'Arndt, Thomas',              'tmarndt11@gmail.com',        'thomas@simple.biz',    '2/26/18'),
  ('US Manager Bonus', 'Thibodeau, Jeffrey "Jeff"',  'jefft149@yahoo.com',         'jeff@simple.biz',      '2/24/20'),
  ('HR',               'Lepley, Teal',               'tclepley@ncsu.edu',          'teal@simple.biz',      '7/28/20'),
  ('US Manager Bonus', 'Thomas, Carla',              'carlathomas0112@gmail.com',  'carla@simple.biz',     '4/5/21'),
  ('Hogan Smith Law',  'Kitson, Emma',               'emmakitson@gmail.com',       'emma@simple.biz',      '8/31/21'),
  ('US Manager Bonus', 'Zapata, Jaquelin "Jackie"',  'zapatajaquelin@icloud.com',  'jackie@simple.biz',    '10/25/21'),
  ('Hogan Smith Law',  'Andresen, Courtney',         'cdandresen13@gmail.com',     'courtney@simple.biz',  '10/28/21'),
  ('US Manager Bonus', 'Lee, Seungyong',             NULL,                         'seungyong@simple.biz', '11/8/21'),
  ('Hogan Smith Law',  'Charland, Nicholas',         'nickccharland@gmail.com',    'nicholas@simple.biz',  '12/6/21'),
  ('Hogan Smith Law',  'Foote, Sterling',            'sterlinghfoote@gmail.com',   'sterling@simple.biz',  '9/12/22'),
  ('Hogan Smith Law',  'Fierro, Nicolas "Adrian"',   NULL,                         'adrian@simple.biz',    '9/11/25'),
  ('Hogan Smith Law',  'Biggs, Brandon',             NULL,                         'brandonb@simple.biz',  '4/8/26')
)
INSERT INTO public.global_master_list (
  "Department", "Name", "Personal Email", "Work Email", "Start Date",
  first_seen_upload_id, last_seen_upload_id, source_file
)
SELECT u.dept, u.nm, u.pers, u.work, u.start_date, c.id, c.id, 'manual_us_seed_2026-04-30'
FROM us_employees u
CROSS JOIN curr c
WHERE NOT EXISTS (
  SELECT 1 FROM public.global_master_list g
  WHERE LOWER(g."Work Email") = LOWER(u.work)
);

-- ── Verify the rows landed and are tagged with the current upload ──
SELECT
  g."Department",
  g."Name",
  g."Work Email",
  g."Personal Email",
  g."Start Date",
  (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = true LIMIT 1)) AS visible_in_active
FROM public.global_master_list g
WHERE LOWER(g."Work Email") IN (
  'thomas@simple.biz','jeff@simple.biz','teal@simple.biz','carla@simple.biz',
  'emma@simple.biz','jackie@simple.biz','courtney@simple.biz','seungyong@simple.biz',
  'nicholas@simple.biz','sterling@simple.biz','adrian@simple.biz','brandonb@simple.biz'
)
ORDER BY g."Start Date"::date;
