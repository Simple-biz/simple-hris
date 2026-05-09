'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Cake,
  Lightbulb,
  Loader2,
  Package,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type CatalogItem = {
  id: string;
  item: string;
  description: string;
  price_php: number;
};

export type AnniversaryGift = {
  id: string;
  year: number; // e.g. 0.5, 1, 1.5
  month_label: string; // e.g. "6 Month Gift"
  gift: string;
  usd_est: number;
};

export type CatalogPayload = {
  items: CatalogItem[];
  anniversaries: AnniversaryGift[];
  suggestions: string[];
};

const DEFAULT_PAYLOAD: CatalogPayload = {
  items: [
    { id: 'i1', item: 'Mug', description: 'Regular ceramic mug', price_php: 140 },
    { id: 'i2', item: 'Tote Bag', description: 'Small', price_php: 280 },
    { id: 'i3', item: 'Tote Bag', description: 'Medium', price_php: 320 },
    { id: 'i4', item: 'Hat', description: 'Cap (Logo can be embroided)', price_php: 350 },
    { id: 'i5', item: 'Tote Bag', description: 'Large', price_php: 400 },
    { id: 'i6', item: 'Tshirt', description: 'XS', price_php: 430 },
    { id: 'i7', item: 'Tshirt', description: 'Small', price_php: 430 },
    { id: 'i8', item: 'Tshirt', description: 'Medium', price_php: 430 },
    { id: 'i9', item: 'Tshirt', description: 'Large', price_php: 430 },
    { id: 'i10', item: 'Tshirt', description: 'XL', price_php: 430 },
    { id: 'i11', item: 'Tshirt', description: '2XL', price_php: 450 },
    { id: 'i12', item: 'Tshirt', description: '3XL', price_php: 450 },
    {
      id: 'i13',
      item: 'Planner',
      description: "PU leather cover binder with ballpen (company logo and employee's name on cover)",
      price_php: 450,
    },
    {
      id: 'i14',
      item: 'Speaker (Square)',
      description: 'With company logo and employee name (laser engraved)',
      price_php: 550,
    },
    {
      id: 'i15',
      item: 'Speaker (Circle)',
      description: 'With company logo and employee name (laser engraved)',
      price_php: 550,
    },
    {
      id: 'i16',
      item: 'Tumbler',
      description: '20oz hot and cold sublimated tumbler with company logo, can include name of employee',
      price_php: 600,
    },
    {
      id: 'i17',
      item: 'Powerbank',
      description: 'With company logo and employee name (laser engraved)',
      price_php: 600,
    },
    { id: 'i18', item: 'Hoodie Jacket', description: 'With company logo embroidery', price_php: 800 },
    { id: 'i19', item: 'Zippered Jacket', description: 'With company logo embroidery', price_php: 900 },
  ],
  anniversaries: [
    { id: 'a1', year: 0.5, month_label: '6 Month Gift', gift: 'Tshirt', usd_est: 7.77 },
    { id: 'a2', year: 1, month_label: '12 Month Gift', gift: 'Tumbler', usd_est: 10.36 },
    { id: 'a3', year: 1.5, month_label: '18 Month Gift', gift: 'Hoodie Jacket', usd_est: 13.82 },
    { id: 'a4', year: 2, month_label: '24 Month Gift', gift: 'Tote Bag & Mug', usd_est: 7.26 },
    { id: 'a5', year: 2.5, month_label: '30 Month Gift', gift: 'Hat & Polo', usd_est: 14.35 },
    { id: 'a6', year: 3, month_label: '36 Month Gift', gift: 'Speaker', usd_est: 0 },
    { id: 'a7', year: 3.5, month_label: '42 Month Gift', gift: '', usd_est: 0 },
    { id: 'a8', year: 4, month_label: '48 Month Gift', gift: '', usd_est: 0 },
  ],
  suggestions: ['Office Chair/Desk', 'Coffee Maker', 'power supply - generator', 'Paid Day Off'],
};

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function GiftCatalog({ viewerEmail }: { viewerEmail?: string | null } = {}) {
  const [payload, setPayload] = useState<CatalogPayload>(DEFAULT_PAYLOAD);
  const [originalJson, setOriginalJson] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/gift-catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { catalog?: CatalogPayload; error?: string | null }) => {
        if (cancelled) return;
        const c = json.catalog;
        // Empty/uninitialized catalog → seed with defaults so the UI isn't blank.
        const isEmpty =
          !c || ((c.items ?? []).length === 0 && (c.anniversaries ?? []).length === 0 && (c.suggestions ?? []).length === 0);
        const next = isEmpty ? DEFAULT_PAYLOAD : {
          items: c.items ?? [],
          anniversaries: c.anniversaries ?? [],
          suggestions: c.suggestions ?? [],
        };
        setPayload(next);
        setOriginalJson(JSON.stringify(next));
      })
      .catch(() => {
        if (!cancelled) {
          setPayload(DEFAULT_PAYLOAD);
          setOriginalJson(JSON.stringify(DEFAULT_PAYLOAD));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => JSON.stringify(payload) !== originalJson, [payload, originalJson]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/gift-catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalog: payload, updated_by: viewerEmail ?? null }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      setOriginalJson(JSON.stringify(payload));
      toast.success('Catalog saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save catalog');
    } finally {
      setSaving(false);
    }
  }, [payload, viewerEmail]);

  const updateItem = (id: string, patch: Partial<CatalogItem>) => {
    setPayload((p) => ({
      ...p,
      items: p.items.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };
  const removeItem = (id: string) => {
    setPayload((p) => ({ ...p, items: p.items.filter((row) => row.id !== id) }));
  };
  const addItem = () => {
    setPayload((p) => ({
      ...p,
      items: [...p.items, { id: genId(), item: '', description: '', price_php: 0 }],
    }));
  };

  const updateAnniv = (id: string, patch: Partial<AnniversaryGift>) => {
    setPayload((p) => ({
      ...p,
      anniversaries: p.anniversaries.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };
  const removeAnniv = (id: string) => {
    setPayload((p) => ({ ...p, anniversaries: p.anniversaries.filter((row) => row.id !== id) }));
  };
  const addAnniv = () => {
    setPayload((p) => {
      const lastYear = p.anniversaries.at(-1)?.year ?? 0;
      const nextYear = +(lastYear + 0.5).toFixed(1);
      const nextMonth = Math.round(nextYear * 12);
      return {
        ...p,
        anniversaries: [
          ...p.anniversaries,
          {
            id: genId(),
            year: nextYear,
            month_label: `${nextMonth} Month Gift`,
            gift: '',
            usd_est: 0,
          },
        ],
      };
    });
  };

  const updateSuggestion = (idx: number, value: string) => {
    setPayload((p) => ({
      ...p,
      suggestions: p.suggestions.map((s, i) => (i === idx ? value : s)),
    }));
  };
  const removeSuggestion = (idx: number) => {
    setPayload((p) => ({ ...p, suggestions: p.suggestions.filter((_, i) => i !== idx) }));
  };
  const addSuggestion = () => {
    setPayload((p) => ({ ...p, suggestions: [...p.suggestions, ''] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog…
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-6"
    >
      {/* Save bar */}
      <div
        className={cn(
          'sticky top-0 z-10 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 backdrop-blur-md transition-colors',
          dirty
            ? 'border-orange-300 bg-orange-50/95 dark:border-orange-800/70 dark:bg-orange-950/40'
            : 'border-pink-100/80 bg-white/85 dark:border-pink-950/50 dark:bg-zinc-950/70',
        )}
      >
        <span className="text-xs text-zinc-600 dark:text-zinc-300">
          {dirty ? 'Unsaved changes — click Save to persist.' : 'All changes saved.'}
        </span>
        <Button
          size="sm"
          className="h-8 bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25 hover:from-pink-700 hover:to-rose-800"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-3.5 w-3.5" />
          )}
          Save catalog
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        {/* Items table */}
        <Card className="border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
          <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 text-white shadow-sm shadow-sky-500/25">
                  <Package className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold">Gift items</CardTitle>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-pink-100/70 dark:border-pink-900/50"
                onClick={addItem}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add item
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Catalog of items that can be sent as a gift. Prices in PHP.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto rounded-lg border border-pink-100/80 dark:border-pink-900/50">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-gradient-to-r from-sky-50 via-white to-sky-50/80 text-xs text-zinc-600 dark:from-sky-950/40 dark:via-zinc-950 dark:to-sky-950/30 dark:text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Item</th>
                    <th className="px-3 py-2 font-semibold">Description</th>
                    <th className="px-3 py-2 font-semibold w-[120px]">Price (PHP)</th>
                    <th className="px-2 py-2 w-[1%]" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-pink-100/60 dark:divide-pink-900/30">
                  {payload.items.map((row) => (
                    <motion.tr
                      key={row.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.18 }}
                      className="align-top hover:bg-pink-50/30 dark:hover:bg-pink-950/20"
                    >
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.item}
                          onChange={(e) => updateItem(row.id, { item: e.target.value })}
                          className="h-8 border-zinc-200 text-xs dark:border-zinc-700"
                          placeholder="Item name"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.description}
                          onChange={(e) => updateItem(row.id, { description: e.target.value })}
                          className="h-8 border-zinc-200 text-xs dark:border-zinc-700"
                          placeholder="Description"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          step="0.01"
                          value={row.price_php}
                          onChange={(e) =>
                            updateItem(row.id, { price_php: Number(e.target.value) || 0 })
                          }
                          className="h-8 border-zinc-200 text-xs tabular-nums dark:border-zinc-700"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                          onClick={() => removeItem(row.id)}
                          aria-label="Remove item"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </motion.tr>
                  ))}
                  {payload.items.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-xs text-zinc-400">
                        No items yet — click "Add item".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Anniversary Gifts table */}
        <Card className="border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
          <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-sm shadow-emerald-500/25">
                  <Cake className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold">Anniversary Gifts</CardTitle>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-pink-100/70 dark:border-pink-900/50"
                onClick={addAnniv}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add tier
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Maps each tenure milestone to the gift sent that month.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto rounded-lg border border-pink-100/80 dark:border-pink-900/50">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead className="bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/40 dark:via-zinc-950 dark:to-emerald-950/30 dark:text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 font-semibold w-[64px]">Year</th>
                    <th className="px-3 py-2 font-semibold">Month</th>
                    <th className="px-3 py-2 font-semibold">Gift</th>
                    <th className="px-3 py-2 font-semibold w-[96px]">USD est.</th>
                    <th className="px-2 py-2 w-[1%]" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-pink-100/60 dark:divide-pink-900/30">
                  {payload.anniversaries.map((row) => (
                    <motion.tr
                      key={row.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.18 }}
                      className="align-top hover:bg-pink-50/30 dark:hover:bg-pink-950/20"
                    >
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          step="0.5"
                          value={row.year}
                          onChange={(e) => updateAnniv(row.id, { year: Number(e.target.value) || 0 })}
                          className="h-8 border-zinc-200 text-xs tabular-nums dark:border-zinc-700"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.month_label}
                          onChange={(e) => updateAnniv(row.id, { month_label: e.target.value })}
                          className="h-8 border-zinc-200 text-xs dark:border-zinc-700"
                          placeholder="6 Month Gift"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.gift}
                          onChange={(e) => updateAnniv(row.id, { gift: e.target.value })}
                          className="h-8 border-zinc-200 text-xs dark:border-zinc-700"
                          placeholder="Gift name"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          step="0.01"
                          value={row.usd_est}
                          onChange={(e) =>
                            updateAnniv(row.id, { usd_est: Number(e.target.value) || 0 })
                          }
                          className="h-8 border-zinc-200 text-xs tabular-nums dark:border-zinc-700"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                          onClick={() => removeAnniv(row.id)}
                          aria-label="Remove tier"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </motion.tr>
                  ))}
                  {payload.anniversaries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-xs text-zinc-400">
                        No tiers yet — click "Add tier".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Suggestions */}
      <Card className="border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
        <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-white shadow-sm shadow-amber-500/25">
                <Lightbulb className="h-4 w-4" />
              </div>
              <CardTitle className="text-base font-semibold">Suggestions</CardTitle>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-pink-100/70 dark:border-pink-900/50"
              onClick={addSuggestion}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add suggestion
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Free-form ideas not yet in the catalog.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-4">
          {payload.suggestions.length === 0 ? (
            <p className="rounded-md border border-dashed border-pink-200 bg-white/60 px-3 py-4 text-center text-xs text-zinc-500 dark:border-pink-900/50 dark:bg-zinc-950/40">
              No suggestions yet.
            </p>
          ) : (
            payload.suggestions.map((s, idx) => (
              <motion.div
                key={`${idx}-${s.length}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18 }}
                className="flex items-center gap-2"
              >
                <Input
                  value={s}
                  onChange={(e) => updateSuggestion(idx, e.target.value)}
                  className="h-8 border-zinc-200 text-xs dark:border-zinc-700"
                  placeholder="Suggestion text"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                  onClick={() => removeSuggestion(idx)}
                  aria-label="Remove suggestion"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </motion.div>
            ))
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
