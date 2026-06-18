-- HSL SSD Medical Records — sub-team assignments (BLUE / GREEN / YELLOW / ORANGE / PURPLE / RED)
-- Run AFTER seed_hsl_team_members.sql. Idempotent — safe to re-run.
--
-- Adds the `sub_team` column to public.hsl_team_members so the KPI Calculator
-- can pre-fill the SSD sub-team dropdown when creating new bonus entries.

ALTER TABLE public.hsl_team_members
  ADD COLUMN IF NOT EXISTS sub_team text;

-- Constrain values (gated so re-runs don't fail)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hsl_team_members_sub_team_check'
  ) THEN
    ALTER TABLE public.hsl_team_members
      ADD CONSTRAINT hsl_team_members_sub_team_check
      CHECK (sub_team IS NULL OR sub_team IN ('BLUE','GREEN','YELLOW','ORANGE','PURPLE','RED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hsl_team_members_sub_team_idx ON public.hsl_team_members(sub_team);

-- ── BLUE TEAM ───────────────────────────────────────────────────────────────
UPDATE public.hsl_team_members SET sub_team = 'BLUE' WHERE email IN (
  'nete@simple.biz',        -- Carol
  'cjc@simple.biz',         -- Claire
  'angeld@simple.biz',      -- Dalia
  'guiaq@simple.biz',       -- Gail
  'marjf@simple.biz',       -- Maggie
  'rochelled@simple.biz',   -- Rochelle
  'robt@simple.biz',        -- Roland
  'tinem@simple.biz',       -- Trina
  'mayt@simple.biz',        -- Maya
  'airahe@simple.biz'       -- Scarlet
);

-- ── ORANGE TEAM ─────────────────────────────────────────────────────────────
UPDATE public.hsl_team_members SET sub_team = 'ORANGE' WHERE email IN (
  'vanp@simple.biz',        -- Van
  'ruffamaeg@simple.biz',   -- Winter
  'jomsa@simple.biz',       -- Gavin
  'zaka@simple.biz',        -- Ashton
  'erjiee@simple.biz',      -- Bailey   (Estolonio, Erjie)
  'ralfp@simple.biz',       -- Liam
  'roda@simple.biz',        -- Tino     (Alejandre, Girod "Rod")
  'gleng@simple.biz',       -- Glenda
  'hannaa@simple.biz',      -- Hazel
  'tonrayc@simple.biz'      -- Tracy
);

-- ── GREEN TEAM ──────────────────────────────────────────────────────────────
UPDATE public.hsl_team_members SET sub_team = 'GREEN' WHERE email IN (
  'johnbv@simple.biz',      -- Noah
  'carlylec@simple.biz',    -- Carlyle
  'mikeb@simple.biz',       -- Milton
  'jammers@simple.biz',     -- Jasper
  'aprill@simple.biz',      -- Verbane  (Lapaz, April)
  'charlesc@simple.biz',    -- Charles  (Dela Cruz, Charles Kerzey)
  'kimbr@simple.biz',       -- Chad     (Briones, Kim)
  'melvsf@simple.biz',      -- Emerald
  'reeds@simple.biz',       -- Reed
  'janp@simple.biz'         -- Vera
);

-- ── YELLOW TEAM ─────────────────────────────────────────────────────────────
UPDATE public.hsl_team_members SET sub_team = 'YELLOW' WHERE email IN (
  'ninac@simple.biz',           -- Nina
  'melchezedeks@simple.biz',    -- Matthew
  'jeriemym@simple.biz',        -- Jerry
  'maddies@simple.biz',         -- Maddie
  'ralphr@simple.biz',          -- Ralph
  'markd@simple.biz',           -- Vince
  'jedp@simple.biz',            -- Derek
  'edm@simple.biz',             -- Ezra
  'marjunm@simple.biz'          -- June
);

-- ── PURPLE TEAM ─────────────────────────────────────────────────────────────
UPDATE public.hsl_team_members SET sub_team = 'PURPLE' WHERE email IN (
  'noimeg@simple.biz',      -- Naomi
  'dextert@simple.biz',     -- Dexter
  'vinzm@simple.biz',       -- Vincent
  'geloa@simple.biz',       -- Angelo
  'rosep@simple.biz',       -- Rose
  'cannys@simple.biz',      -- Canny
  'miahl@simple.biz',       -- Matias
  'cassiusc@simple.biz',    -- Cassius
  'angelc@simple.biz',      -- Alice
  'cindyg@simple.biz'       -- Cecilia
);

-- ── RED TEAM (single-member SOLO substitute) ────────────────────────────────
UPDATE public.hsl_team_members SET sub_team = 'RED' WHERE email = 'jeromea@simple.biz';

-- Audit:
--   SELECT sub_team, count(*)
--   FROM public.hsl_team_members
--   WHERE dept_key = 'ssd_medical_records'
--   GROUP BY sub_team
--   ORDER BY 1 NULLS LAST;
--
-- Expected:
--   BLUE   = 10
--   GREEN  = 10
--   ORANGE = 10
--   PURPLE = 10
--   RED    = 1
--   YELLOW = 9
--   (total assigned = 50)
