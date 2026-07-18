'use client';

import React from 'react';
import { Eraser } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Draw-your-signature canvas (mouse / touch / pen). Emits a trimmed,
 * transparent-background PNG data URL after every stroke — `null` while empty.
 * Used by Accounting → Documents to capture the Accounting Head's signature,
 * which is then stamped onto approved documents.
 */
export default function SignaturePad({
  onChange,
  heightClassName = 'h-40',
  className,
}: {
  /** Fired after each stroke / clear with the current PNG data URL (null = blank). */
  onChange: (dataUrl: string | null) => void;
  heightClassName?: string;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  const lastRef = React.useRef<{ x: number; y: number } | null>(null);
  const inkedRef = React.useRef(false);
  const [inked, setInked] = React.useState(false);

  // Size the bitmap to the rendered box × devicePixelRatio so strokes stay crisp.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // Preserve the current drawing across resizes (e.g. mobile rotation).
      const prev = inkedRef.current ? canvas.toDataURL('image/png') : null;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = '#1c2340';
      if (prev) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
        img.src = prev;
      }
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);
    return () => obs.disconnect();
  }, []);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
      let minX = width, minY = height, maxX = -1, maxY = -1;
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
      ctx.fillStyle = '#1c2340';
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
    <div className={cn('space-y-2', className)}>
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
