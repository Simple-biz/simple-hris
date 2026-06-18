-- Seed: gift_catalog default payload
-- Created: 2026-05-11
--
-- Writes the canonical catalog (items + anniversaries + suggestions) used by
-- the Orphanage team's Gift Tracker and the approval dialog's gift picker.
-- Mirrors `DEFAULT_PAYLOAD` in `src/components/orphanage/GiftCatalog.tsx`.
--
-- Item PHP prices come from the orphanage team's pricing sheet. Anniversaries
-- are the per-milestone gift mapping (6mo → Tshirt, 12mo → Tumbler, …).
--
-- Idempotent: rerunning is safe — `ON CONFLICT (id) DO UPDATE` overwrites the
-- payload in place. Re-run any time the canonical defaults change. If you've
-- already edited the catalog in the UI and want to PRESERVE those edits, do
-- NOT run this migration; otherwise it will replace them.

BEGIN;

INSERT INTO public.gift_catalog (id, items, anniversaries, suggestions, updated_by)
VALUES (
  1,
  '[
    {"id":"i1","item":"Mug","description":"Regular ceramic mug","price_php":140},
    {"id":"i2","item":"Tote Bag","description":"Small","price_php":280},
    {"id":"i3","item":"Tote Bag","description":"Medium","price_php":320},
    {"id":"i4","item":"Hat","description":"Cap (Logo can be embroided)","price_php":350},
    {"id":"i5","item":"Tote Bag","description":"Large","price_php":400},
    {"id":"i6","item":"Tshirt","description":"XS","price_php":430},
    {"id":"i7","item":"Tshirt","description":"Small","price_php":430},
    {"id":"i8","item":"Tshirt","description":"Medium","price_php":430},
    {"id":"i9","item":"Tshirt","description":"Large","price_php":430},
    {"id":"i10","item":"Tshirt","description":"XL","price_php":430},
    {"id":"i11","item":"Tshirt","description":"2XL","price_php":450},
    {"id":"i12","item":"Tshirt","description":"3XL","price_php":450},
    {"id":"i13","item":"Planner","description":"PU leather cover binder with ballpen (company logo and employee''s name on cover)","price_php":450},
    {"id":"i14","item":"Speaker (Square)","description":"With company logo and employee name (laser engraved)","price_php":550},
    {"id":"i15","item":"Speaker (Circle)","description":"With company logo and employee name (laser engraved)","price_php":550},
    {"id":"i16","item":"Tumbler","description":"20oz hot and cold sublimated tumbler with company logo, can include name of employee","price_php":600},
    {"id":"i17","item":"Powerbank","description":"With company logo and employee name (laser engraved)","price_php":600},
    {"id":"i18","item":"Hoodie Jacket","description":"With company logo embroidery","price_php":800},
    {"id":"i19","item":"Zippered Jacket","description":"With company logo embroidery","price_php":900}
  ]'::jsonb,
  '[
    {"id":"a1","year":0.5,"month_label":"6 Month Gift","gift":"Tshirt","usd_est":7.77},
    {"id":"a2","year":1,"month_label":"12 Month Gift","gift":"Tumbler","usd_est":10.36},
    {"id":"a3","year":1.5,"month_label":"18 Month Gift","gift":"Hoodie Jacket","usd_est":13.82},
    {"id":"a4","year":2,"month_label":"24 Month Gift","gift":"Tote Bag & Mug","usd_est":7.26},
    {"id":"a5","year":2.5,"month_label":"30 Month Gift","gift":"Hat & Polo","usd_est":14.35},
    {"id":"a6","year":3,"month_label":"36 Month Gift","gift":"Speaker","usd_est":0},
    {"id":"a7","year":3.5,"month_label":"42 Month Gift","gift":"","usd_est":0},
    {"id":"a8","year":4,"month_label":"48 Month Gift","gift":"","usd_est":0}
  ]'::jsonb,
  '["Office Chair/Desk","Coffee Maker","power supply - generator","Paid Day Off"]'::jsonb,
  'seed_script'
)
ON CONFLICT (id) DO UPDATE
SET items         = EXCLUDED.items,
    anniversaries = EXCLUDED.anniversaries,
    suggestions   = EXCLUDED.suggestions,
    updated_by    = EXCLUDED.updated_by;

COMMIT;

-- Verification: should show 19 items, 8 anniversaries, 4 suggestions.
-- SELECT jsonb_array_length(items)         AS item_count,
--        jsonb_array_length(anniversaries) AS anniv_count,
--        jsonb_array_length(suggestions)   AS sugg_count
-- FROM public.gift_catalog WHERE id = 1;
