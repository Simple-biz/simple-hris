import 'server-only';

import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import {
  SCOREBOARD_LIVE_EVENT,
  SCOREBOARD_LIVE_TOPIC,
  SCOREBOARD_TAB_HEADER,
  parseTabId,
  type ScoreboardLiveKind,
  type ScoreboardLivePayload,
} from './live';

/**
 * Server half of the scoreboard's live channel (`live.ts`). Called by every board write route AFTER the write
 * succeeded, through `after()` (next/server), never `void`: work left dangling after a response can be frozen
 * with the function, and a dropped message is the staleness this channel exists to remove. It resolves, never
 * rejects, and never fails the write (`broadcastFromServer` swallows and logs). A message that still gets lost
 * costs each open board its 45 s tick.
 *
 * The payload names what changed and which tab wrote it, never a value (`live.ts`).
 */
export async function announceScoreboardChange(kind: ScoreboardLiveKind, req: Request): Promise<void> {
  const payload: ScoreboardLivePayload = {
    kind,
    origin: parseTabId(req.headers.get(SCOREBOARD_TAB_HEADER)),
    ts: Date.now(),
  };
  await broadcastFromServer(SCOREBOARD_LIVE_TOPIC, SCOREBOARD_LIVE_EVENT, { ...payload });
}
