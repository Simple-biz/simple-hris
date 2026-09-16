-- HR -> MESA -> FPU Classes: an optional free-text NAME per class.
-- Kane, 2026-09-16, after the first cut: "I should be able to ... set the Batch
-- name" -> "Add it please." The (year, batch) pair stays the identity and the
-- generated code "FPU 2026 - Batch 1" is always shown; the name is what HR calls
-- the cohort, e.g. "Summer Cohort". Idempotent; also folded into the CREATE file
-- so a fresh install gets it in one pass.

alter table public.fpu_classes
  add column if not exists name text;

alter table public.fpu_classes
  drop constraint if exists fpu_classes_name_len;
alter table public.fpu_classes
  add constraint fpu_classes_name_len
    check (name is null or (length(btrim(name)) between 1 and 80));

comment on column public.fpu_classes.name is
  'Optional cohort name HR gives the class. The label is name when set, else "FPU <year> - Batch <batch>"; the code is always shown.';
