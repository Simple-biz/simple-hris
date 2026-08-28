'use client';

import React from 'react';
import { Eraser, PenLine, Type as TypeIcon, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  bitmapSizeFor,
  canvasPointFromEvent,
  type BitmapSize,
} from '@/lib/documents/signature-canvas';
import {
  SIGNATURE_FACES,
  fontStack,
  uncoveredCharacters,
  type SignatureFace,
} from '@/lib/documents/signature-fonts';
import {
  RASTER_PADDING,
  exceedsSignatureBudget,
  planRasterAttempts,
  planSignatureRaster,
} from '@/lib/documents/signature-render';

/**
 * Signature capture, in two modes that produce the SAME artifact.
 *
 * The contract is one callback — `onChange(pngDataUrl | null)` — emitting a
 * trimmed, transparent-background PNG. Draw and Type are two ways to make that
 * PNG; nothing downstream (the save route, signatures.ts, sign-pdf.ts,
 * coe-document.ts, storage, the audit log) can tell them apart, which is why
 * this feature needed no server change at all.
 *
 * Draw is the default. Type is the option to its right.
 */

const INK = '#1c2340';

type Mode = 'draw' | 'type';

export default function SignaturePad({
  onChange,
  heightClassName = 'h-40',
  className,
  defaultName = '',
}: {
  /** Fired after each stroke / clear / keystroke with the current PNG data URL
   *  (null = nothing to save). */
  onChange: (dataUrl: string | null) => void;
  heightClassName?: string;
  className?: string;
  /** Seeds Type mode so the signer usually just picks a face. */
  defaultName?: string;
}) {
  const [mode, setMode] = React.useState<Mode>('draw');

  // Switching modes discards the other mode's output rather than leaving a
  // stale signature staged behind a tab the signer is no longer looking at.
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    onChange(null);
  };

  return (
    <div className={cn('space-y-2.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Signature method"
          className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60"
        >
          <ModeTab
            Icon={PenLine}
            label="Draw"
            active={mode === 'draw'}
            onClick={() => switchMode('draw')}
          />
          <ModeTab
            Icon={TypeIcon}
            label="Type"
            active={mode === 'type'}
            onClick={() => switchMode('type')}
          />
        </div>
        <p className="text-[11px] text-zinc-400">
          {mode === 'draw' ? 'Mouse, finger or pen' : 'Pick a style'}
        </p>
      </div>

      {mode === 'draw' ? (
        <DrawMode onChange={onChange} heightClassName={heightClassName} />
      ) : (
        <TypeMode onChange={onChange} defaultName={defaultName} />
      )}
    </div>
  );
}

function ModeTab({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof PenLine;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// ── Draw ─────────────────────────────────────────────────────────────────────

function DrawMode({
  onChange,
  heightClassName,
}: {
  onChange: (dataUrl: string | null) => void;
  heightClassName: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  const lastRef = React.useRef<{ x: number; y: number } | null>(null);
  const inkedRef = React.useRef(false);
  /** CSS units the drawing surface spans — the other half of the pointer
   *  mapping, kept in a ref so pointer handlers never read a stale render. */
  const sizeRef = React.useRef<BitmapSize | null>(null);
  const [inked, setInked] = React.useState(false);

  // Size the bitmap from the LAYOUT box, not getBoundingClientRect().
  //
  // This pad opens inside a Dialog that animates in with `zoom-in-[0.94]` +
  // `slide-in-from-bottom-6` over 320ms, so a rect read on mount is the
  // TRANSFORMED box — which is what used to make the ink land a centimetre off
  // the pointer near the right edge. offsetWidth/offsetHeight ignore ancestor
  // transforms, and canvasPointFromEvent() divides out whatever transform is
  // live at the moment of each event. See src/lib/documents/signature-canvas.ts.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const size = bitmapSizeFor({
        layoutWidth: canvas.offsetWidth,
        layoutHeight: canvas.offsetHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
      if (
        sizeRef.current &&
        sizeRef.current.width === size.width &&
        sizeRef.current.height === size.height
      ) {
        return; // nothing changed — don't churn the bitmap and lose the ink
      }

      // Preserve the current drawing across resizes (e.g. mobile rotation).
      const prev = inkedRef.current ? canvas.toDataURL('image/png') : null;
      canvas.width = size.width;
      canvas.height = size.height;
      sizeRef.current = size;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(size.dpr, size.dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = INK;
      if (prev) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, size.cssWidth, size.cssHeight);
        img.src = prev;
      }
    };

    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);
    return () => obs.disconnect();
  }, []);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const size = sizeRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    return canvasPointFromEvent({
      clientX: e.clientX,
      clientY: e.clientY,
      rect,
      cssWidth: size?.cssWidth ?? rect.width,
      cssHeight: size?.cssHeight ?? rect.height,
    });
  };

  /** Crop to the inked bounding box (+ padding) so the stamp scales nicely. */
  const emit = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!inkedRef.current) {
      onChange(null);
      return;
    }
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        onChange(null);
        return;
      }
      const pad = 8;
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(width - 1, maxX + pad);
      maxY = Math.min(height - 1, maxY + pad);
      const out = document.createElement('canvas');
      out.width = maxX - minX + 1;
      out.height = maxY - minY + 1;
      const octx = out.getContext('2d');
      if (!octx) return;
      octx.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
      onChange(out.toDataURL('image/png'));
    } catch {
      // Fallback: untrimmed export.
      onChange(canvas.toDataURL('image/png'));
    }
  }, [onChange]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = pointFromEvent(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const last = lastRef.current;
    if (!canvas || !ctx || !last) return;
    const pt = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastRef.current = pt;
    if (!inkedRef.current) {
      inkedRef.current = true;
      setInked(true);
    }
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    // A tap without movement still leaves a dot.
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const last = lastRef.current;
    if (ctx && last && !inkedRef.current) {
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      inkedRef.current = true;
      setInked(true);
    }
    drawingRef.current = false;
    lastRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    emit();
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    inkedRef.current = false;
    setInked(false);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'relative overflow-hidden rounded-xl border-2 border-dashed border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-100',
          heightClassName,
        )}
      >
        {/* Baseline the signature sits on. */}
        <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-zinc-300" />
        {!inked && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm italic text-zinc-400">
            Sign here with your mouse, finger or pen
          </span>
        )}
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          aria-label="Signature drawing area"
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clear}
          disabled={!inked}
          className="gap-1.5 text-xs"
        >
          <Eraser className="h-3.5 w-3.5" />
          Clear
        </Button>
      </div>
    </div>
  );
}

// ── Type ─────────────────────────────────────────────────────────────────────

/** Font size used for measuring and drawing before the raster plan scales it.
 *  Large enough that ctx.measureText's bounding box is precise. */
const MEASURE_SIZE = 160;

type FaceStatus = 'loading' | 'ready' | 'unavailable';

function TypeMode({
  onChange,
  defaultName,
}: {
  onChange: (dataUrl: string | null) => void;
  defaultName: string;
}) {
  const [name, setName] = React.useState(defaultName);
  const [faceId, setFaceId] = React.useState(SIGNATURE_FACES[0].id);
  const [status, setStatus] = React.useState<Record<string, FaceStatus>>({});
  const [tooLarge, setTooLarge] = React.useState(false);

  // Load every face up front and record which actually arrived.
  //
  // This is the guard that makes Type mode trustworthy: canvas 2D silently
  // falls back to the generic family when a font is missing, so without an
  // explicit check a failed load would rasterise and SAVE a signature that is
  // not cursive, with nothing to see in the UI and no error server-side. A face
  // that fails is disabled in the picker instead of being quietly substituted.
  React.useEffect(() => {
    let cancelled = false;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;

    if (!fonts) {
      // No Font Loading API — we cannot prove a face is present, so we must not
      // claim it is. Everything degrades to "draw it instead".
      setStatus(Object.fromEntries(SIGNATURE_FACES.map((f) => [f.id, 'unavailable' as const])));
      return;
    }

    setStatus(Object.fromEntries(SIGNATURE_FACES.map((f) => [f.id, 'loading' as const])));

    for (const face of SIGNATURE_FACES) {
      const spec = `${MEASURE_SIZE}px '${face.family}'`;
      fonts
        .load(spec, 'Signature')
        .then(() => {
          if (cancelled) return;
          // load() resolving is not proof on its own — check() is what confirms
          // the family is actually available for that spec.
          const ok = fonts.check(spec, 'Signature');
          setStatus((prev) => ({ ...prev, [face.id]: ok ? 'ready' : 'unavailable' }));
        })
        .catch(() => {
          if (!cancelled) setStatus((prev) => ({ ...prev, [face.id]: 'unavailable' }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const face = SIGNATURE_FACES.find((f) => f.id === faceId) ?? SIGNATURE_FACES[0];
  const trimmed = name.trim();
  const missing = trimmed ? uncoveredCharacters(face, trimmed) : [];
  const faceStatus = status[face.id] ?? 'loading';
  const blocked = !trimmed || missing.length > 0 || faceStatus !== 'ready';

  // Rasterise whenever the inputs settle.
  React.useEffect(() => {
    if (blocked) {
      onChange(null);
      setTooLarge(false);
      return;
    }
    const dataUrl = rasterizeTypedSignature(trimmed, face);
    if (!dataUrl) {
      onChange(null);
      setTooLarge(true);
      return;
    }
    setTooLarge(false);
    onChange(dataUrl);
  }, [trimmed, face, blocked, onChange]);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          Your name, as you sign it
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Carla Mendoza"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        {SIGNATURE_FACES.map((f) => {
          const st = status[f.id] ?? 'loading';
          const unusable = st !== 'ready';
          const cannotDraw = trimmed ? uncoveredCharacters(f, trimmed).length > 0 : false;
          const disabled = unusable || cannotDraw;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => !disabled && setFaceId(f.id)}
              disabled={disabled}
              aria-pressed={f.id === faceId}
              className={cn(
                'group flex h-[74px] flex-col items-start justify-center rounded-xl border px-3.5 text-left transition-colors',
                f.id === faceId && !disabled
                  ? 'border-orange-400 bg-orange-50/60 dark:border-orange-500/50 dark:bg-orange-500/10'
                  : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950/40',
                disabled && 'cursor-not-allowed opacity-45',
              )}
            >
              <span
                className="max-w-full truncate text-[26px] leading-tight text-zinc-900 dark:text-zinc-100"
                style={{ fontFamily: fontStack(f) }}
              >
                {trimmed || 'Your name'}
              </span>
              <span className="mt-0.5 text-[10.5px] uppercase tracking-wide text-zinc-400">
                {st === 'loading'
                  ? 'Loading…'
                  : st === 'unavailable'
                    ? 'Unavailable'
                    : cannotDraw
                      ? "Can't draw this name"
                      : f.note}
              </span>
            </button>
          );
        })}
      </div>

      {missing.length > 0 && (
        <Notice>
          <strong>{face.label}</strong> has no letterform for{' '}
          {missing.map((c) => `"${c}"`).join(', ')}. Pick another style, or draw your signature
          instead — it would otherwise print as a blank box.
        </Notice>
      )}
      {faceStatus === 'unavailable' && (
        <Notice>
          <strong>{face.label}</strong> didn&apos;t load, so it can&apos;t be used. Pick another
          style or draw your signature.
        </Notice>
      )}
      {tooLarge && (
        <Notice>
          That name is too long to save as an image. Try a shorter form of it — initials for the
          middle names, say — or draw your signature instead.
        </Notice>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Draw the name in `face` and return a trimmed transparent PNG data URL — the
 * same artifact the drawing pad emits.
 *
 * The ink box is MEASURED rather than derived from font metrics, so faces that
 * use wildly different amounts of the em still come out visually matched.
 * Returns null when even the smallest attempt overruns the data-URL budget the
 * save route enforces.
 */
function rasterizeTypedSignature(text: string, face: SignatureFace): string | null {
  for (const target of planRasterAttempts()) {
    const dataUrl = drawAtHeight(text, face, target);
    if (dataUrl && !exceedsSignatureBudget(dataUrl)) return dataUrl;
  }
  return null;
}

function drawAtHeight(text: string, face: SignatureFace, targetHeight: number): string | null {
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;

  const font = `${MEASURE_SIZE * face.sizeHint}px ${fontStack(face)}`;
  measure.font = font;
  const m = measure.measureText(text);

  // actualBoundingBox* is the real ink extent, including the descenders and
  // swashes cursive faces are full of — `width` alone would clip them.
  const left = m.actualBoundingBoxLeft;
  const right = m.actualBoundingBoxRight;
  const ascent = m.actualBoundingBoxAscent;
  const descent = m.actualBoundingBoxDescent;
  if (![left, right, ascent, descent].every((v) => Number.isFinite(v))) return null;

  const inkWidth = left + right;
  const inkHeight = ascent + descent;
  if (inkWidth <= 0 || inkHeight <= 0) return null;

  const plan = planSignatureRaster({ width: inkWidth, height: inkHeight }, targetHeight);

  const out = document.createElement('canvas');
  out.width = plan.width;
  out.height = plan.height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  ctx.scale(plan.scale, plan.scale);
  ctx.font = font;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  // Place the ink box's top-left at the padding, converting from the measuring
  // origin (which sits on the baseline, `left` to the right of the ink's edge).
  ctx.fillText(text, RASTER_PADDING / plan.scale + left, RASTER_PADDING / plan.scale + ascent);

  return out.toDataURL('image/png');
}
