import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROCESSOR_OPTIONS, WALLET_RAILS } from '@/lib/employee-payment-processors';
import {
  ALLOWED_PUBLIC_LOGO_SRCS,
  PAY_PROCESSOR_LOGO_MAX_BYTES,
  SEED_CREATED_AT,
  SEED_LOGO_SRC,
  applyPayProcessorPatch,
  base64DecodedBytes,
  buildPayProcessor,
  codeRoutingFor,
  codeSeedProcessors,
  isUnsavedSeed,
  mergeRegistryOverCode,
  routingDrift,
  sanitizePayProcessor,
  slugifyProcessorId,
  validatePayProcessorInput,
  validatePayProcessorLogo,
  type PayProcessor,
} from './pay-processors';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function pngDataUrl(bytes: number): { dataUrl: string; mime: string; bytes: number } {
  const buf = Buffer.alloc(bytes, 7);
  return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, mime: 'image/png', bytes };
}

// ── Seeds mirror code ────────────────────────────────────────────────────────

test('one seed per code processor, classification = WALLET_RAILS membership', () => {
  const seeds = codeSeedProcessors();
  assert.deepEqual(
    seeds.map((s) => s.id).sort(),
    PROCESSOR_OPTIONS.map((p) => p.id).sort(),
  );
  for (const s of seeds) {
    const expected = (WALLET_RAILS as readonly string[]).includes(s.id) ? 'one_to_one' : 'multi_peer';
    assert.equal(s.routing, expected, `${s.id} seeds as ${expected}`);
    assert.equal(s.wiredInCode, true);
    assert.equal(isUnsavedSeed(s), true);
  }
});

test("Kolan keeps the id 'hurupay' and the label Kolan; wires reads x1153; Wepay is retired", () => {
  const byId = new Map(codeSeedProcessors().map((s) => [s.id, s]));
  assert.equal(byId.get('hurupay')?.label, 'Kolan');
  assert.equal(byId.get('hurupay')?.routing, 'one_to_one');
  assert.equal(byId.get('higlobe')?.routing, 'one_to_one');
  assert.equal(byId.get('wires')?.label, 'x1153');
  assert.equal(byId.get('wise')?.routing, 'multi_peer');
  assert.equal(byId.get('wepay')?.status, 'retired');
  assert.equal(byId.get('wise')?.status, 'active');
  assert.equal(byId.get('jeeves')?.status, 'active');
});

test('every seed logo exists in public/ with the exact on-disk casing', () => {
  // `fs.existsSync` is case-insensitive on Windows; Linux static serving is not.
  // The same silent failure the dispatch registries guard against: a missing
  // asset falls back to the monogram tile and nothing errors.
  const listing = fs.readdirSync(path.join(REPO_ROOT, 'public'));
  for (const src of Object.values(SEED_LOGO_SRC)) {
    assert.ok(src?.startsWith('/'), `${src} must be public-root absolute`);
    assert.ok(listing.includes(src!.slice(1)), `public${src} must exist case-exactly (have: ${listing.filter((f) => f.toLowerCase() === src!.slice(1).toLowerCase()).join(', ') || 'nothing'})`);
  }
});

test('Kolan seeds the PLATED lockup, the same asset the dispatch cards use', () => {
  // This tab renders on ProcessorLogo's white plate. The bare-chip mark /kolan.svg
  // would be padded down to a sticker here. Pinned per surface, see
  // memory/hurupay-kolan-rebrand.md.
  assert.equal(SEED_LOGO_SRC.hurupay, '/Kolan.png');
  assert.ok(ALLOWED_PUBLIC_LOGO_SRCS.has('/Kolan.png'));
  assert.ok(!ALLOWED_PUBLIC_LOGO_SRCS.has('/kolan.svg'));
});

// ── Drift ────────────────────────────────────────────────────────────────────

test('routingDrift: null when registry agrees with code, null for custom ids, non-null on disagreement', () => {
  assert.equal(routingDrift({ id: 'hurupay', routing: 'one_to_one' }), null);
  assert.equal(routingDrift({ id: 'paypal', routing: 'multi_peer' }), null);
  assert.deepEqual(routingDrift({ id: 'hurupay', routing: 'multi_peer' }), {
    code: 'one_to_one',
    registry: 'multi_peer',
  });
  assert.deepEqual(routingDrift({ id: 'wise', routing: 'one_to_one' }), {
    code: 'multi_peer',
    registry: 'one_to_one',
  });
  assert.equal(codeRoutingFor('nope'), null);
});

// ── Merge ────────────────────────────────────────────────────────────────────

test('mergeRegistryOverCode: stored rows win, seeds fill gaps, wiredInCode is re-derived, active sorts first', () => {
  const storedKolan: PayProcessor = {
    ...codeSeedProcessors().find((s) => s.id === 'hurupay')!,
    label: 'Kolan (PH wallet)',
    notes: 'Login owned by Lenny',
    wiredInCode: false, // a stored blob cannot demote a wired id
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const custom: PayProcessor = {
    ...buildPayProcessor({ label: 'PayPal', routing: 'multi_peer' }, 'kaner@simple.biz', '2026-09-03T00:00:00.000Z'),
    wiredInCode: true, // a stored blob cannot promote a custom id either
  };
  const merged = mergeRegistryOverCode([storedKolan, custom]);

  assert.equal(merged.length, PROCESSOR_OPTIONS.length + 1);
  const kolan = merged.find((p) => p.id === 'hurupay')!;
  assert.equal(kolan.label, 'Kolan (PH wallet)');
  assert.equal(kolan.wiredInCode, true);
  const paypal = merged.find((p) => p.id === 'paypal')!;
  assert.equal(paypal.wiredInCode, false);
  // Wepay (retired) is last.
  assert.equal(merged[merged.length - 1].id, 'wepay');
  // Every wired id that was NOT stored is still present as an unsaved seed.
  assert.ok(isUnsavedSeed(merged.find((p) => p.id === 'wise')!));
});

// ── Validation ───────────────────────────────────────────────────────────────

test('slugifyProcessorId', () => {
  assert.equal(slugifyProcessorId('  PayPal (PH) '), 'paypal_ph');
  assert.equal(slugifyProcessorId('***'), '');
});

test('validatePayProcessorInput: create rejects a colliding slug, edit does not', () => {
  const ids = new Set(codeSeedProcessors().map((s) => s.id));
  assert.equal(validatePayProcessorInput({ label: 'Wise', routing: 'multi_peer' }, 'create', ids).ok, false);
  assert.equal(validatePayProcessorInput({ label: 'Wise', routing: 'multi_peer' }, 'edit', ids).ok, true);
  assert.equal(validatePayProcessorInput({ label: 'PayPal', routing: 'multi_peer' }, 'create', ids).ok, true);
});

test('validatePayProcessorInput: required and bounded fields', () => {
  const ids = new Set<string>();
  assert.equal(validatePayProcessorInput({ label: '', routing: 'multi_peer' }, 'create', ids).ok, false);
  assert.equal(validatePayProcessorInput({ label: 'X', routing: 'sideways' }, 'create', ids).ok, false);
  assert.equal(validatePayProcessorInput({ label: 'X', routing: 'one_to_one', status: 'gone' }, 'create', ids).ok, false);
  assert.equal(validatePayProcessorInput({ label: 'x'.repeat(41), routing: 'one_to_one' }, 'create', ids).ok, false);
  assert.equal(
    validatePayProcessorInput({ label: 'X', routing: 'one_to_one', blurb: 'b'.repeat(81) }, 'create', ids).ok,
    false,
  );
  assert.equal(
    validatePayProcessorInput({ label: 'X', routing: 'one_to_one', notes: 'n'.repeat(501) }, 'create', ids).ok,
    false,
  );
  assert.equal(validatePayProcessorInput(null, 'create', ids).ok, false);
});

test('validatePayProcessorLogo: public paths only from the seed set', () => {
  assert.equal(validatePayProcessorLogo({ kind: 'public', src: '/wise.png' }).ok, true);
  assert.equal(validatePayProcessorLogo({ kind: 'public', src: '/kolan.svg' }).ok, false);
  assert.equal(validatePayProcessorLogo({ kind: 'public', src: '../../etc/passwd' }).ok, false);
  assert.equal(validatePayProcessorLogo(null).ok, true);
  assert.equal(validatePayProcessorLogo('nope').ok, false);
  assert.equal(validatePayProcessorLogo({ kind: 'url', src: 'https://x' }).ok, false);
});

test('validatePayProcessorLogo: data URLs — MIME allowlist, prefix match, real size, size claim', () => {
  const ok = pngDataUrl(1000);
  assert.equal(validatePayProcessorLogo({ kind: 'data', ...ok }).ok, true);
  // Declared MIME must match the data URL prefix.
  assert.equal(validatePayProcessorLogo({ kind: 'data', ...ok, mime: 'image/webp' }).ok, false);
  // Disallowed MIME.
  const gif = { dataUrl: `data:image/gif;base64,${Buffer.alloc(10).toString('base64')}`, mime: 'image/gif', bytes: 10 };
  assert.equal(validatePayProcessorLogo({ kind: 'data', ...gif }).ok, false);
  // Over the cap, measured from the base64 — not from the caller's claim.
  const big = pngDataUrl(PAY_PROCESSOR_LOGO_MAX_BYTES + 1);
  assert.equal(validatePayProcessorLogo({ kind: 'data', ...big, bytes: 10 }).ok, false);
  // Right at the cap is fine.
  const atCap = pngDataUrl(PAY_PROCESSOR_LOGO_MAX_BYTES);
  assert.equal(validatePayProcessorLogo({ kind: 'data', ...atCap }).ok, true);
  // Lying about the size.
  assert.equal(validatePayProcessorLogo({ kind: 'data', ...ok, bytes: 5 }).ok, false);
  // Empty payload.
  assert.equal(validatePayProcessorLogo({ kind: 'data', dataUrl: 'data:image/png;base64,', mime: 'image/png', bytes: 0 }).ok, false);
  // Not base64.
  assert.equal(validatePayProcessorLogo({ kind: 'data', dataUrl: 'data:image/png;base64,<svg onload=alert(1)>', mime: 'image/png', bytes: 20 }).ok, false);
});

test('base64DecodedBytes is padding-aware', () => {
  for (const n of [1, 2, 3, 4, 5, 1000, 150 * 1024]) {
    assert.equal(base64DecodedBytes(Buffer.alloc(n).toString('base64')), n);
  }
  assert.equal(base64DecodedBytes(''), 0);
});

// ── Mutations ────────────────────────────────────────────────────────────────

test('applyPayProcessorPatch: id, wiredInCode, createdBy/createdAt are immutable; first save of a seed stamps creation', () => {
  const seed = codeSeedProcessors().find((s) => s.id === 'hurupay')!;
  const now = '2026-09-03T10:00:00.000Z';
  const edited = applyPayProcessorPatch(
    seed,
    { label: 'Kolan Wallet', routing: 'multi_peer', notes: 'drifted on purpose' },
    'kaner@simple.biz',
    now,
  );
  assert.equal(edited.id, 'hurupay');
  assert.equal(edited.wiredInCode, true);
  assert.equal(edited.label, 'Kolan Wallet');
  assert.equal(edited.routing, 'multi_peer');
  assert.equal(edited.createdBy, 'kaner@simple.biz');
  assert.equal(edited.createdAt, now);
  assert.equal(edited.updatedAt, now);
  assert.notEqual(routingDrift(edited), null);
  // Logo omitted ⇒ kept; explicit null ⇒ cleared.
  assert.deepEqual(edited.logo, seed.logo);
  assert.equal(applyPayProcessorPatch(edited, { label: 'K', routing: 'one_to_one', logo: null }, 'a', now).logo, null);

  // Second edit keeps the original creation.
  const again = applyPayProcessorPatch(edited, { label: 'Kolan', routing: 'one_to_one' }, 'lenny@simple.biz', '2026-09-04T00:00:00.000Z');
  assert.equal(again.createdBy, 'kaner@simple.biz');
  assert.equal(again.createdAt, now);
  assert.equal(again.updatedBy, 'lenny@simple.biz');
});

test('buildPayProcessor: custom rows are never wired and default active', () => {
  const p = buildPayProcessor({ label: ' PayPal ', routing: 'multi_peer' }, 'kaner@simple.biz', '2026-09-03T00:00:00.000Z');
  assert.equal(p.id, 'paypal');
  assert.equal(p.label, 'PayPal');
  assert.equal(p.wiredInCode, false);
  assert.equal(p.status, 'active');
  assert.equal(p.logo, null);
});

// ── Sanitising ───────────────────────────────────────────────────────────────

test('sanitizePayProcessor: strict on identity, re-derives wiredInCode, drops a bad logo rather than the row', () => {
  assert.equal(sanitizePayProcessor(null), null);
  assert.equal(sanitizePayProcessor({ id: 'x', label: '' }), null);
  assert.equal(sanitizePayProcessor({ id: 'Has Spaces', label: 'X', routing: 'multi_peer', status: 'active' }), null);
  assert.equal(sanitizePayProcessor({ id: 'x', label: 'X', routing: 'weird', status: 'active' }), null);

  const row = sanitizePayProcessor({
    id: 'hurupay',
    label: 'Kolan',
    routing: 'one_to_one',
    status: 'active',
    wiredInCode: false,
    logo: { kind: 'public', src: '/not-shipped.png' },
    createdAt: '',
  })!;
  assert.equal(row.wiredInCode, true);
  assert.equal(row.logo, null);
  assert.equal(row.createdAt, SEED_CREATED_AT);

  const custom = sanitizePayProcessor({ id: 'paypal', label: 'PayPal', routing: 'multi_peer', status: 'active', wiredInCode: true })!;
  assert.equal(custom.wiredInCode, false);
});
