'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  ClipboardPaste,
  Eraser,
  Redo2,
  Trash2,
  Undo2,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { NpdColumn } from '@/lib/npd/columns';
import { parseClipboardGrid, serializeClipboardGrid } from '@/lib/npd/clipboard';
import {
  applyPaste,
  clearRange,
  deleteRows,
  insertRows,
  isBlankRow,
  normalizeRange,
  rangeToMatrix,
  setCell,
  trimTrailingBlankRows,
  type CellPos,
  type CellRange,
  type NpdRow,
} from '@/lib/npd/sheet';
import { newRowId } from './useNpdSheet';

/**
 * The NPD spreadsheet grid. Governing doc: docs/features/npd-dashboard.md.
 *
 * Built like a sheet, not a form: cells render as text and ONE editor exists at a
 * time, on the active cell, so ~10,000 cells stay cheap. Rows are memoised and the
 * model keeps untouched rows' identity (sheet.ts), so an edit re-renders one row.
 *
 * Keyboard: arrows move (Shift extends, Ctrl/⌘ jumps to the edge) · Enter / F2 /
 * double-click edit · typing replaces · Enter commits down, Tab right, Esc cancels
 * · Alt+Enter is a line break inside a cell · Delete clears · Ctrl/⌘+Z / Y undo /
 * redo · Ctrl/⌘+A selects all · Ctrl/⌘+C / X / V copy, cut and paste TSV, which
 * is what Google Sheets puts on the clipboard.
 *
 * Phone-table traps (memory payroll-wizard-hris-vs-npd), all handled here: the
 * table opts out of the global responsive card layout (`table-keep`), its width
 * is an explicit `width` (a `min-width` on a fixed table is ignored), and the
 * scroller is `relative` so nothing positioned inside it escapes the clip.
 */

const ROW_HEAD_W = 52;
const SHEET_FONT = 'text-[13px]';

type Editing = { row: number; col: number; draft: string; mode: 'type' | 'edit' };

type Props = {
  columns: readonly NpdColumn[];
  rows: readonly NpdRow[];
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onCommit: (next: NpdRow[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** One sentence for the dashboard's notice line (paste results, refusals). */
  onNotice: (message: string) => void;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export default function NpdSheetGrid({
  columns,
  rows,
  readOnly,
  canUndo,
  canRedo,
  onCommit,
  onUndo,
  onRedo,
  onNotice,
}: Props) {
  const [anchor, setAnchor] = useState<CellPos>({ row: 0, col: 0 });
  const [focus, setFocus] = useState<CellPos>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const draggingRef = useRef(false);
  const scrollIntentRef = useRef(false);

  const lastRow = Math.max(0, rows.length - 1);
  const lastCol = columns.length - 1;
  const clampPos = useCallback(
    (p: CellPos): CellPos => ({ row: clamp(p.row, 0, Math.max(0, rowsRef.current.length - 1)), col: clamp(p.col, 0, lastCol) }),
    [lastCol],
  );
  const a = clampPos(anchor);
  const f = clampPos(focus);
  const sel: CellRange = normalizeRange(a, f);
  const filledRows = useMemo(() => trimTrailingBlankRows(rows).length, [rows]);

  const totalWidth = useMemo(() => ROW_HEAD_W + columns.reduce((s, c) => s + c.width, 0), [columns]);
  const stickyLeft = ROW_HEAD_W; // the Work Email column

  const focusGrid = () => containerRef.current?.focus({ preventScroll: true });

  const moveTo = useCallback(
    (p: CellPos, extend: boolean) => {
      const q = clampPos(p);
      scrollIntentRef.current = true;
      setFocus(q);
      if (!extend) setAnchor(q);
    },
    [clampPos],
  );

  // Keep the cell the keyboard moved to in view (scroll-margins clear the sticky parts).
  useEffect(() => {
    if (!scrollIntentRef.current) return;
    scrollIntentRef.current = false;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-cell="${f.row}:${f.col}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [f.row, f.col]);

  // ── Editing ───────────────────────────────────────────────────────────────
  const startEdit = useCallback(
    (pos: CellPos, initial: string | null) => {
      if (readOnly) return;
      const row = rowsRef.current[pos.row];
      if (!row) return;
      setEditing({
        row: pos.row,
        col: pos.col,
        draft: initial ?? row.values[pos.col] ?? '',
        mode: initial === null ? 'edit' : 'type',
      });
    },
    [readOnly],
  );

  /** Commit the open editor (if any). Idempotent: blur after a key commit is a no-op. */
  const commitEdit = useCallback(
    (move?: { dr: number; dc: number }) => {
      const e = editingRef.current;
      if (!e) return;
      editingRef.current = null;
      setEditing(null);
      const current = rowsRef.current[e.row]?.values[e.col] ?? '';
      if (e.draft !== current) onCommit(setCell(rowsRef.current, { row: e.row, col: e.col }, e.draft));
      if (move) moveTo({ row: e.row + move.dr, col: e.col + move.dc }, false);
      focusGrid();
    },
    [onCommit, moveTo],
  );

  const cancelEdit = useCallback(() => {
    editingRef.current = null;
    setEditing(null);
    focusGrid();
  }, []);

  const onDraft = useCallback((draft: string) => {
    setEditing((e) => (e ? { ...e, draft } : e));
  }, []);

  const onEditKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const e = editingRef.current;
      if (!e) return;
      ev.stopPropagation();
      if (ev.key === 'Enter' && ev.altKey) {
        // A line break inside the cell, like the sheet's Alt+Enter.
        ev.preventDefault();
        const t = ev.currentTarget;
        const at = t.selectionStart ?? e.draft.length;
        const end = t.selectionEnd ?? at;
        const next = `${e.draft.slice(0, at)}\n${e.draft.slice(end)}`;
        onDraft(next);
        requestAnimationFrame(() => t.setSelectionRange(at + 1, at + 1));
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitEdit({ dr: ev.shiftKey ? -1 : 1, dc: 0 });
      } else if (ev.key === 'Tab') {
        ev.preventDefault();
        commitEdit({ dr: 0, dc: ev.shiftKey ? -1 : 1 });
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelEdit();
      } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        if (e.mode === 'type' || !e.draft.includes('\n')) {
          ev.preventDefault();
          commitEdit({ dr: ev.key === 'ArrowUp' ? -1 : 1, dc: 0 });
        }
      } else if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && e.mode === 'type') {
        ev.preventDefault();
        commitEdit({ dr: 0, dc: ev.key === 'ArrowLeft' ? -1 : 1 });
      }
    },
    [commitEdit, cancelEdit, onDraft],
  );

  const onEditBlur = useCallback(() => commitEdit(), [commitEdit]);

  // ── Paste / copy ──────────────────────────────────────────────────────────
  const doPaste = useCallback(
    (text: string, at: CellPos, selection: CellRange | null) => {
      if (readOnly) {
        onNotice('View only — this sheet cannot be changed from your account.');
        return;
      }
      const matrix = parseClipboardGrid(text);
      const out = applyPaste(rowsRef.current, at, matrix, columns, newRowId, selection);
      if (!out) return;
      const pasted = out.range.r1 - out.range.r0 + 1;
      const notes: string[] = [];
      if (out.headerSkipped) notes.push('The header row was skipped.');
      if (out.droppedColumns > 0) notes.push(`${plural(out.droppedColumns, 'column')} past the last column (${columns[lastCol]!.header.replace(/\n/g, ' ')}) were not pasted.`);
      if (out.droppedRows > 0) notes.push(`${plural(out.droppedRows, 'line')} past the ${'2,000'}-row limit were not pasted.`);
      if (out.clippedCells > 0) notes.push(`${plural(out.clippedCells, 'cell')} over 5,000 characters were cut short.`);
      if (pasted > 0 && !(out.headerSkipped && matrix.length === 1)) {
        onCommit(out.rows);
        setAnchor({ row: out.range.r0, col: out.range.c0 });
        setFocus({ row: out.range.r1, col: out.range.c1 });
        onNotice([`Pasted ${plural(pasted, 'row')}.`, ...notes].join(' '));
      } else {
        onNotice(notes.join(' ') || 'Nothing to paste.');
      }
    },
    [readOnly, columns, lastCol, onCommit, onNotice],
  );

  const onPaste = (ev: React.ClipboardEvent<HTMLDivElement>) => {
    const text = ev.clipboardData.getData('text/plain');
    const e = editingRef.current;
    if (e) {
      // Inside a cell a plain word pastes into the text; a copied BLOCK is a grid paste.
      if (!/[\t\n\r]/.test(text)) return;
      ev.preventDefault();
      editingRef.current = null;
      setEditing(null);
      doPaste(text, { row: e.row, col: e.col }, null);
      focusGrid();
      return;
    }
    ev.preventDefault();
    doPaste(text, { row: sel.r0, col: sel.c0 }, sel);
  };

  const onCopy = (ev: React.ClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return;
    ev.preventDefault();
    ev.clipboardData.setData('text/plain', serializeClipboardGrid(rangeToMatrix(rowsRef.current, sel)));
  };

  const onCut = (ev: React.ClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return;
    onCopy(ev);
    if (!readOnly) onCommit(clearRange(rowsRef.current, sel));
  };

  // ── Row actions ───────────────────────────────────────────────────────────
  const insertAt = (index: number) => {
    if (readOnly) return;
    onCommit(insertRows(rowsRef.current, index, 1, columns.length, newRowId));
    moveTo({ row: index, col: f.col }, false);
    focusGrid();
  };

  const deleteSelectedRows = () => {
    if (readOnly) return;
    const count = sel.r1 - sel.r0 + 1;
    const filled = rowsRef.current.slice(sel.r0, sel.r1 + 1).filter((r) => !isBlankRow(r)).length;
    onCommit(deleteRows(rowsRef.current, sel.r0, sel.r1));
    moveTo({ row: sel.r0, col: f.col }, false);
    if (filled > 0) onNotice(`Deleted ${plural(count, 'row')}. Ctrl+Z puts ${count === 1 ? 'it' : 'them'} back.`);
    focusGrid();
  };

  const clearSelectedCells = () => {
    if (readOnly) return;
    onCommit(clearRange(rowsRef.current, sel));
    focusGrid();
  };

  const clearSheet = () => {
    if (readOnly) return;
    setConfirmClear(false);
    onCommit([]);
    moveTo({ row: 0, col: 0 }, false);
    onNotice(`Cleared ${plural(filledRows, 'row')}. Ctrl+Z puts them back until you leave this sheet.`);
    focusGrid();
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key;
    const page = 20;

    if (mod && (k === 'z' || k === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (mod && (k === 'y' || k === 'Y')) {
      ev.preventDefault();
      onRedo();
      return;
    }
    if (mod && (k === 'a' || k === 'A')) {
      ev.preventDefault();
      setAnchor({ row: 0, col: 0 });
      setFocus({ row: Math.max(0, filledRows - 1), col: lastCol });
      return;
    }
    if (mod && (k === 'c' || k === 'x' || k === 'v' || k === 'C' || k === 'X' || k === 'V')) return; // clipboard events

    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (k in step) {
      ev.preventDefault();
      const [dr, dc] = step[k]!;
      const target = mod
        ? {
            row: dr === 0 ? f.row : dr < 0 ? 0 : Math.max(0, filledRows - 1),
            col: dc === 0 ? f.col : dc < 0 ? 0 : lastCol,
          }
        : { row: f.row + dr, col: f.col + dc };
      moveTo(target, ev.shiftKey);
      return;
    }
    if (k === 'Tab') {
      ev.preventDefault();
      moveTo({ row: f.row, col: f.col + (ev.shiftKey ? -1 : 1) }, false);
      return;
    }
    if (k === 'Home' || k === 'End') {
      ev.preventDefault();
      if (mod) moveTo(k === 'Home' ? { row: 0, col: 0 } : { row: Math.max(0, filledRows - 1), col: lastCol }, ev.shiftKey);
      else moveTo({ row: f.row, col: k === 'Home' ? 0 : lastCol }, ev.shiftKey);
      return;
    }
    if (k === 'PageDown' || k === 'PageUp') {
      ev.preventDefault();
      moveTo({ row: f.row + (k === 'PageDown' ? page : -page), col: f.col }, ev.shiftKey);
      return;
    }
    if (k === 'Enter' || k === 'F2') {
      ev.preventDefault();
      startEdit(f, null);
      return;
    }
    if (k === 'Escape') {
      setAnchor(f);
      return;
    }
    if (k === 'Delete' || k === 'Backspace') {
      ev.preventDefault();
      clearSelectedCells();
      return;
    }
    if (k.length === 1 && !mod && !ev.altKey) {
      ev.preventDefault();
      setAnchor(f);
      startEdit(f, k);
    }
  };

  // ── Mouse ─────────────────────────────────────────────────────────────────
  const cellFromEvent = (ev: React.MouseEvent): CellPos | null => {
    const td = (ev.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!td) return null;
    const [r, c] = (td.dataset.cell ?? '').split(':').map(Number);
    return Number.isFinite(r) && Number.isFinite(c) ? { row: r!, col: c! } : null;
  };

  const onMouseDown = (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    const pos = cellFromEvent(ev);
    if (!pos) return;
    if (editingRef.current) {
      const e = editingRef.current;
      if (e.row === pos.row && e.col === pos.col) return; // clicking inside the open editor
      commitEdit();
    }
    ev.preventDefault();
    focusGrid();
    setFocus(pos);
    if (!ev.shiftKey) setAnchor(pos);
    draggingRef.current = true;
  };

  const onMouseOver = (ev: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const pos = cellFromEvent(ev);
    if (pos) setFocus(pos);
  };

  const onDoubleClick = (ev: React.MouseEvent) => {
    const pos = cellFromEvent(ev);
    if (pos) startEdit(pos, null);
  };

  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const selectRow = (r: number, extend: boolean) => {
    if (editingRef.current) commitEdit();
    focusGrid();
    setFocus({ row: r, col: lastCol });
    setAnchor(extend ? { row: a.row, col: 0 } : { row: r, col: 0 });
  };

  const selectColumn = (c: number, extend: boolean) => {
    if (editingRef.current) commitEdit();
    focusGrid();
    setFocus({ row: Math.max(0, filledRows - 1), col: c });
    setAnchor(extend ? { row: 0, col: a.col } : { row: 0, col: c });
  };

  const activeColumn = columns[f.col]!;
  const activeValue = rows[f.row]?.values[f.col] ?? '';
  const selCells = (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5" data-readonly-allow>
        <ToolButton label="Undo (Ctrl+Z)" disabled={readOnly || !canUndo} onClick={onUndo}>
          <Undo2 className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton label="Redo (Ctrl+Y)" disabled={readOnly || !canRedo} onClick={onRedo}>
          <Redo2 className="h-3.5 w-3.5" />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden />
        <ToolButton label="Insert a row above" disabled={readOnly} onClick={() => insertAt(sel.r0)}>
          <BetweenHorizontalStart className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Row above</span>
        </ToolButton>
        <ToolButton label="Insert a row below" disabled={readOnly} onClick={() => insertAt(sel.r1 + 1)}>
          <BetweenHorizontalEnd className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Row below</span>
        </ToolButton>
        <ToolButton
          label={`Delete ${sel.r1 > sel.r0 ? `rows ${sel.r0 + 1}–${sel.r1 + 1}` : `row ${sel.r0 + 1}`}`}
          disabled={readOnly}
          onClick={deleteSelectedRows}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Delete {sel.r1 > sel.r0 ? 'rows' : 'row'}</span>
        </ToolButton>
        <ToolButton label="Clear the selected cells (Delete)" disabled={readOnly} onClick={clearSelectedCells}>
          <Eraser className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Clear cells</span>
        </ToolButton>

        <div className="ml-auto flex items-center gap-1.5">
          {confirmClear ? (
            <>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                Delete all {plural(filledRows, 'row')}?
              </span>
              <button
                type="button"
                onClick={clearSheet}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              >
                Delete all
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={readOnly || filledRows === 0}
              onClick={() => setConfirmClear(true)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-red-600 enabled:hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400 dark:enabled:hover:bg-red-950/40"
            >
              Delete all rows
            </button>
          )}
        </div>
      </div>

      {/* Active cell bar — the full text of a cell the grid truncates */}
      <div className="flex min-h-9 items-stretch overflow-hidden rounded-lg border border-zinc-200 bg-white text-xs dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex shrink-0 items-center gap-1.5 border-r border-zinc-200 bg-zinc-50 px-2.5 font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <span className="tabular-nums">R{f.row + 1}</span>
          <span className="text-zinc-300 dark:text-zinc-700">·</span>
          <span className="max-w-[12rem] truncate">{activeColumn.header.replace(/\s*\n\s*/g, ' ')}</span>
          {selCells > 1 && (
            <span className="ml-1 rounded bg-orange-100 px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
              {plural(selCells, 'cell')}
            </span>
          )}
        </div>
        <div className="max-h-16 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 text-zinc-800 dark:text-zinc-200">
          {editing ? editing.draft : activeValue || <span className="text-zinc-400 dark:text-zinc-600">Empty cell</span>}
        </div>
      </div>

      {/* The grid */}
      <div
        ref={containerRef}
        role="grid"
        aria-label="NPD sheet"
        aria-readonly={readOnly}
        aria-rowcount={rows.length}
        aria-colcount={columns.length}
        tabIndex={0}
        data-readonly-allow
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCopy={onCopy}
        onCut={onCut}
        className="relative min-h-[18rem] flex-1 overflow-auto rounded-xl border border-zinc-200 bg-white outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 dark:border-zinc-800 dark:bg-[#0d1117]"
      >
        <table
          className={cn('table-keep table-fixed select-none border-separate border-spacing-0', SHEET_FONT)}
          style={{ width: totalWidth }}
        >
          <colgroup>
            <col style={{ width: ROW_HEAD_W }} />
            {columns.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-30 border-b border-r border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (editingRef.current) commitEdit();
                  focusGrid();
                  setAnchor({ row: 0, col: 0 });
                  setFocus({ row: Math.max(0, filledRows - 1), col: lastCol });
                }}
              >
                <span className="sr-only">Select all</span>
              </th>
              {columns.map((c, i) => {
                const inSel = i >= sel.c0 && i <= sel.c1;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.header.replace(/\s*\n\s*/g, ' ')}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectColumn(i, e.shiftKey);
                    }}
                    className={cn(
                      'sticky top-0 z-20 cursor-pointer whitespace-pre-line border-b border-r border-zinc-200 px-2 py-1.5 text-center align-bottom text-[11px] font-semibold leading-tight text-zinc-700 dark:border-zinc-800 dark:text-zinc-300',
                      inSel ? 'bg-orange-100 dark:bg-[#2a2016]' : 'bg-zinc-100 dark:bg-zinc-900',
                      i === 0 && 'z-30',
                    )}
                    style={i === 0 ? { left: stickyLeft } : undefined}
                  >
                    {c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody onMouseDown={onMouseDown} onMouseOver={onMouseOver} onDoubleClick={onDoubleClick}>
            {rows.map((row, r) => {
              const rowSelected = r >= sel.r0 && r <= sel.r1;
              const isEditRow = editing?.row === r;
              return (
                <GridRow
                  key={row.id}
                  row={row}
                  r={r}
                  columns={columns}
                  selC0={rowSelected ? sel.c0 : -1}
                  selC1={rowSelected ? sel.c1 : -1}
                  activeCol={f.row === r ? f.col : -1}
                  editCol={isEditRow ? editing!.col : -1}
                  editDraft={isEditRow ? editing!.draft : ''}
                  spare={r >= filledRows}
                  stickyLeft={stickyLeft}
                  onDraft={onDraft}
                  onEditKeyDown={onEditKeyDown}
                  onEditBlur={onEditBlur}
                  onSelectRow={selectRow}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <ClipboardPaste className="h-3 w-3" aria-hidden />
          Click a cell, then paste (Ctrl+V) rows copied from the Google Sheet. A copied header row is skipped.
        </span>
        <span>Enter edits · Alt+Enter is a line break · Delete clears · Ctrl+Z undoes</span>
        <span className="ml-auto tabular-nums">
          {plural(filledRows, 'row')} · {columns.length} columns · last row {lastRow + 1}
        </span>
      </p>
    </div>
  );
}

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 transition-colors enabled:hover:border-orange-300 enabled:hover:bg-orange-50 enabled:hover:text-orange-800 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:enabled:hover:border-orange-500/40 dark:enabled:hover:bg-orange-500/10 dark:enabled:hover:text-orange-200"
    >
      {children}
    </button>
  );
}

type RowProps = {
  row: NpdRow;
  r: number;
  columns: readonly NpdColumn[];
  selC0: number;
  selC1: number;
  activeCol: number;
  editCol: number;
  editDraft: string;
  spare: boolean;
  stickyLeft: number;
  onDraft: (draft: string) => void;
  onEditKeyDown: (ev: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onEditBlur: () => void;
  onSelectRow: (r: number, extend: boolean) => void;
};

const GridRow = memo(function GridRow({
  row,
  r,
  columns,
  selC0,
  selC1,
  activeCol,
  editCol,
  editDraft,
  spare,
  stickyLeft,
  onDraft,
  onEditKeyDown,
  onEditBlur,
  onSelectRow,
}: RowProps) {
  const rowSelected = selC0 >= 0;
  return (
    <tr aria-rowindex={r + 1}>
      <th
        scope="row"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelectRow(r, e.shiftKey);
        }}
        className={cn(
          'sticky left-0 z-10 cursor-pointer border-b border-r border-zinc-200 px-1.5 text-right text-[11px] font-medium tabular-nums dark:border-zinc-800',
          rowSelected
            ? 'bg-orange-100 text-orange-800 dark:bg-[#2a2016] dark:text-orange-200'
            : 'bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
          spare && !rowSelected && 'text-zinc-300 dark:text-zinc-700',
        )}
      >
        {r + 1}
      </th>
      {columns.map((col, c) => {
        const v = row.values[c] ?? '';
        const selected = rowSelected && c >= selC0 && c <= selC1;
        const active = activeCol === c;
        const isEditing = editCol === c;
        return (
          <td
            key={col.key}
            data-cell={`${r}:${c}`}
            role="gridcell"
            aria-selected={selected}
            title={v.length > 18 && !isEditing ? v : undefined}
            className={cn(
              'relative h-8 max-w-0 scroll-mt-24 truncate border-b border-r border-zinc-200 px-2 text-zinc-800 dark:border-zinc-800 dark:text-zinc-200',
              col.align === 'right' && 'text-right tabular-nums',
              c === 0 ? 'sticky z-10' : 'scroll-ml-[290px]',
              selected
                ? 'bg-orange-50 dark:bg-[#1d1812]'
                : c === 0
                  ? 'bg-white dark:bg-[#0d1117]'
                  : undefined,
              active && !isEditing && 'ring-2 ring-inset ring-orange-500 dark:ring-orange-400',
            )}
            style={c === 0 ? { left: stickyLeft } : undefined}
          >
            {isEditing ? (
              <CellEditor value={editDraft} align={col.align} onDraft={onDraft} onKeyDown={onEditKeyDown} onBlur={onEditBlur} />
            ) : (
              v
            )}
          </td>
        );
      })}
    </tr>
  );
});

function CellEditor({
  value,
  align,
  onDraft,
  onKeyDown,
  onBlur,
}: {
  value: string;
  align?: 'right';
  onDraft: (draft: string) => void;
  onKeyDown: (ev: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);

  // Grow with its content (multi-line notes) without pushing the rows below.
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = '0px';
    t.style.height = `${Math.max(32, Math.min(t.scrollHeight, 220))}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      spellCheck={false}
      aria-label="Edit cell"
      onChange={(e) => onDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'absolute left-0 top-0 z-40 block w-full min-w-full resize-none overflow-y-auto border-0 bg-white px-2 py-[7px] leading-[18px] text-zinc-900 shadow-lg outline-none ring-2 ring-inset ring-orange-500 dark:bg-zinc-950 dark:text-zinc-100 dark:ring-orange-400',
        SHEET_FONT,
        align === 'right' && 'text-right tabular-nums',
      )}
    />
  );
}
