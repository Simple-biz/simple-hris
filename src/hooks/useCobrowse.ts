'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';

/**
 * Live screen co-browsing for the Accounting dashboard.
 *
 * Every accounting client runs BOTH halves over a single Supabase Realtime
 * channel:
 *
 *  - DRIVER: whenever at least one peer is observing you, we record your live
 *    DOM with rrweb (the whole page — modals, dialogs, formula editors, typing,
 *    scrolling) and stream the events out. Recording is OFF until someone
 *    watches, so there is zero cost when nobody is looking.
 *
 *  - OBSERVER: when you observe a peer, we ask them to start recording, receive
 *    their DOM event stream, and replay it into a container with rrweb's
 *    Replayer in live mode. You see a faithful mirror of their screen.
 *
 * rrweb event payloads (especially the initial full snapshot) are far larger
 * than a single Realtime broadcast message, so each batch of events is
 * JSON-stringified, split into fixed-size chunks, and reassembled on the other
 * end. Realtime delivers messages on one channel in order, so chunk/batch order
 * is preserved.
 */

const CHANNEL = 'accounting-cobrowse';
// Flip to false to silence the co-browse console diagnostics.
const DEBUG = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (...a: any[]) => { if (DEBUG) console.debug('[cobrowse]', ...a); };
const CHUNK_SIZE = 28_000;        // chars per broadcast message (well under the limit)
const FLUSH_MS = 80;              // batch emitted events into ~12 messages/sec
const HEARTBEAT_MS = 3_000;       // observer re-announces it is still watching
const WATCHER_TTL_MS = 9_000;     // driver drops a watcher we haven't heard from
const PRUNE_MS = 3_000;

// rrweb EventType: 2 = FullSnapshot, 4 = Meta. Hard-coded so we don't pull the
// enum into module scope (it would force rrweb to load before it's needed).
const META = 4;
const FULL_SNAPSHOT = 2;

type CbMsg =
  | { t: 'watch';   from: string; target: string }
  | { t: 'unwatch'; from: string; target: string }
  | { t: 'ev';      from: string; eid: number; i: number; n: number; s: string };

export type CobrowseStatus = 'idle' | 'connecting' | 'live';

interface Args {
  selfEmail: string | null | undefined;
  /** The peer we want to watch right now, or null. */
  observedEmail: string | null;
}

interface Result {
  /** Attach to the element the driver's screen should be replayed into. */
  setReplayContainer: (el: HTMLElement | null) => void;
  status: CobrowseStatus;
  /** Recorded viewport size of the driver, for fit-to-container scaling. */
  recordedSize: { w: number; h: number } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RrwebMod = typeof import('rrweb');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = any;

export function useCobrowse({ selfEmail, observedEmail }: Args): Result {
  const normSelf = selfEmail ? normEmail(selfEmail) ?? selfEmail.trim().toLowerCase() : null;

  const [status, setStatus] = useState<CobrowseStatus>('idle');
  const [recordedSize, setRecordedSize] = useState<{ w: number; h: number } | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  const sendRef = useRef<((m: CbMsg) => void) | null>(null);

  // --- driver state ---
  const watchersRef = useRef<Map<string, number>>(new Map());
  const recordingRef = useRef(false);
  const stopFnRef = useRef<(() => void) | null>(null);
  const bufferRef = useRef<AnyEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eidRef = useRef(0);

  // --- observer state ---
  const observedRef = useRef<string | null>(null);
  const rrModRef = useRef<RrwebMod | null>(null);
  const reassembleRef = useRef<Map<number, { n: number; parts: string[]; have: number }>>(new Map());
  const queueRef = useRef<AnyEvent[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replayerRef = useRef<any>(null);
  const startedRef = useRef(false);
  const pendingMetaRef = useRef<AnyEvent | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const recordedSizeRef = useRef<{ w: number; h: number } | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ============================ DRIVER ============================
  const flush = useCallback(() => {
    flushTimerRef.current = null;
    if (!bufferRef.current.length || !sendRef.current || !normSelf) return;
    const batch = bufferRef.current;
    bufferRef.current = [];
    const s = JSON.stringify(batch);
    const eid = ++eidRef.current;
    const n = Math.ceil(s.length / CHUNK_SIZE) || 1;
    for (let i = 0; i < n; i++) {
      sendRef.current({ t: 'ev', from: normSelf, eid, i, n, s: s.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
    }
  }, [normSelf]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);

  const startRecording = useCallback(async () => {
    if (recordingRef.current) return;
    recordingRef.current = true;
    bufferRef.current = [];
    const rr = rrModRef.current ?? (await import('rrweb'));
    rrModRef.current = rr;
    if (!recordingRef.current) return; // watcher left while importing
    log('recording started (watchers:', watchersRef.current.size, ')');
    const stop = rr.record({
      emit: (ev: AnyEvent) => {
        bufferRef.current.push(ev);
        scheduleFlush();
      },
      // The driver's own observer overlay (if they are also watching someone)
      // is marked .rr-block so we don't recursively stream a mirror of a mirror.
      blockClass: 'rr-block',
      recordCanvas: false,
      collectFonts: false,
      sampling: { mousemove: 50, scroll: 100, input: 'last', media: 800 },
    });
    stopFnRef.current = stop ?? null;
  }, [scheduleFlush]);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    stopFnRef.current?.();
    stopFnRef.current = null;
    bufferRef.current = [];
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Restart recording so a freshly-joined observer gets a clean Meta + full
  // snapshot baseline. Existing observers treat the new Meta as a reset.
  const restartRecording = useCallback(() => {
    stopRecording();
    void startRecording();
  }, [stopRecording, startRecording]);

  const noteWatcher = useCallback((from: string) => {
    const had = watchersRef.current.has(from);
    watchersRef.current.set(from, Date.now());
    if (!recordingRef.current) void startRecording();
    else if (!had) restartRecording();
  }, [startRecording, restartRecording]);

  // ============================ OBSERVER ============================
  const fitScale = useCallback(() => {
    const container = containerRef.current;
    const size = recordedSizeRef.current;
    if (!container || !size) return;
    const wrapper = container.querySelector<HTMLElement>('.replayer-wrapper');
    if (!wrapper) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const scale = Math.min(cw / size.w, ch / size.h);
    wrapper.style.position = 'absolute';
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = `scale(${scale})`;
    wrapper.style.left = `${Math.max(0, (cw - size.w * scale) / 2)}px`;
    wrapper.style.top = `${Math.max(0, (ch - size.h * scale) / 2)}px`;
  }, []);

  const destroyReplayer = useCallback(() => {
    try { replayerRef.current?.pause?.(); } catch { /* ignore */ }
    replayerRef.current = null;
    startedRef.current = false;
    if (containerRef.current) containerRef.current.innerHTML = '';
  }, []);

  const initReplayer = useCallback((meta: AnyEvent, full: AnyEvent) => {
    const rr = rrModRef.current;
    const container = containerRef.current;
    if (!rr || !container) return;
    destroyReplayer();
    const replayer = new rr.Replayer([meta, full], {
      liveMode: true,
      root: container,
      mouseTail: false,
      // We render a passive mirror; block any accidental interaction.
      UNSAFE_replayCanvas: false,
    });
    replayer.startLive(full.timestamp);
    replayerRef.current = replayer;
    startedRef.current = true;
    log('live mirror started', recordedSizeRef.current);
    setStatus('live');
    // Defer so the .replayer-wrapper is in the DOM before we measure/scale.
    setTimeout(fitScale, 0);
  }, [destroyReplayer, fitScale]);

  const step = useCallback((ev: AnyEvent) => {
    if (ev?.type === META) {
      pendingMetaRef.current = ev;
      const size = { w: ev.data?.width ?? 0, h: ev.data?.height ?? 0 };
      recordedSizeRef.current = size;
      setRecordedSize(size);
      log('received Meta baseline', size);
      destroyReplayer();
      return;
    }
    if (ev?.type === FULL_SNAPSHOT) {
      if (!startedRef.current && pendingMetaRef.current) {
        initReplayer(pendingMetaRef.current, ev);
      } else if (startedRef.current) {
        try { replayerRef.current?.addEvent(ev); } catch { /* ignore */ }
      }
      return;
    }
    if (startedRef.current) {
      try { replayerRef.current?.addEvent(ev); } catch { /* ignore */ }
    }
    // else: incremental before a baseline snapshot — ignore.
  }, [destroyReplayer, initReplayer]);

  const handleIncomingEvent = useCallback((ev: AnyEvent) => {
    if (!rrModRef.current) {
      queueRef.current.push(ev);
      return;
    }
    step(ev);
  }, [step]);

  // Reassemble a chunked batch; when complete, parse and feed events in order.
  const onChunk = useCallback((msg: Extract<CbMsg, { t: 'ev' }>) => {
    let entry = reassembleRef.current.get(msg.eid);
    if (!entry) {
      entry = { n: msg.n, parts: new Array(msg.n).fill(''), have: 0 };
      reassembleRef.current.set(msg.eid, entry);
    }
    if (entry.parts[msg.i] === '' && msg.s !== '') entry.have += 1;
    entry.parts[msg.i] = msg.s;
    if (entry.have < entry.n) return;
    reassembleRef.current.delete(msg.eid);
    try {
      const events = JSON.parse(entry.parts.join('')) as AnyEvent[];
      for (const ev of events) handleIncomingEvent(ev);
    } catch { /* corrupt batch — skip */ }
  }, [handleIncomingEvent]);

  // ============================ CHANNEL ============================
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !normSelf) return;

    const ch = supabase.channel(CHANNEL, { config: { broadcast: { self: false } } });
    channelRef.current = ch;
    const send = (m: CbMsg) => ch.send({ type: 'broadcast', event: 'cb', payload: m });
    sendRef.current = send;

    ch.on('broadcast', { event: 'cb' }, ({ payload }: { payload: CbMsg }) => {
      if (!payload?.from) return;
      const from = normEmail(payload.from) ?? payload.from.trim().toLowerCase();
      if (from === normSelf) return;

      if (payload.t === 'watch' && payload.target === normSelf) {
        log('watch request from', from, '→ start recording');
        noteWatcher(from);
      } else if (payload.t === 'unwatch' && payload.target === normSelf) {
        watchersRef.current.delete(from);
        log('unwatch from', from, '→ watchers left:', watchersRef.current.size);
        if (watchersRef.current.size === 0) stopRecording();
      } else if (payload.t === 'ev' && from === observedRef.current) {
        onChunk(payload);
      } else if (payload.t === 'ev') {
        // An event arrived but not from the peer we're watching (or from nobody
        // we expect). Surface the mismatch — usually an email-normalization gap.
        log('ignored ev from', from, '(observing', observedRef.current, ')');
      }
    }).subscribe((s: string) => {
      log('channel', s);
      // The observe effect may have fired its first watch before we were
      // subscribed (that send is dropped). Re-announce on connect.
      if (s === 'SUBSCRIBED' && observedRef.current && normSelf) {
        sendRef.current?.({ t: 'watch', from: normSelf, target: observedRef.current });
      }
    });

    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
      sendRef.current = null;
    };
  }, [normSelf, noteWatcher, stopRecording, onChunk]);

  // Prune stale watchers; stop recording once nobody is watching.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - WATCHER_TTL_MS;
      let changed = false;
      for (const [email, ts] of watchersRef.current) {
        if (ts < cutoff) { watchersRef.current.delete(email); changed = true; }
      }
      if (changed && watchersRef.current.size === 0) stopRecording();
    }, PRUNE_MS);
    return () => clearInterval(t);
  }, [stopRecording]);

  // ============================ OBSERVE LIFECYCLE ============================
  useEffect(() => {
    const prev = observedRef.current;
    if (prev && prev !== observedEmail && sendRef.current && normSelf) {
      sendRef.current({ t: 'unwatch', from: normSelf, target: prev });
    }

    // Tear down any prior replay session.
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    reassembleRef.current.clear();
    queueRef.current = [];
    pendingMetaRef.current = null;
    destroyReplayer();
    recordedSizeRef.current = null;
    setRecordedSize(null);

    observedRef.current = observedEmail;

    if (!observedEmail || !normSelf) {
      setStatus('idle');
      return;
    }

    setStatus('connecting');
    // Preload rrweb so events can be replayed without an await race, then drain
    // anything that arrived while it loaded.
    void import('rrweb').then((m) => {
      rrModRef.current = m;
      const q = queueRef.current;
      queueRef.current = [];
      for (const ev of q) step(ev);
    });

    log('observing', observedEmail, '— announcing watch');
    const announce = () => sendRef.current?.({ t: 'watch', from: normSelf, target: observedEmail });
    announce();
    heartbeatRef.current = setInterval(announce, HEARTBEAT_MS);

    return () => {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    };
  }, [observedEmail, normSelf, destroyReplayer, step]);

  // Refit the mirror when the observer's container resizes.
  const setReplayContainer = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
    if (el) setTimeout(fitScale, 0);
  }, [fitScale]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fitScale());
    const el = containerRef.current;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [fitScale, recordedSize]);

  return { setReplayContainer, status, recordedSize };
}
