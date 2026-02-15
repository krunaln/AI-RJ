import type {
  DashboardSnapshot,
  QueueArbitrationDecision,
  QueueItem,
  TimelineClip,
  TimelineSnapshot,
  TimelineTransition
} from "./types";

function decideReason(item: QueueItem): QueueArbitrationDecision["reason"] {
  if (item.source === "manual" && item.pinned) return "manual_pinned";
  if (item.source === "manual") return "manual_priority";
  return "auto_priority";
}

function adaptiveTransitionWindow(item: QueueItem): number {
  if (item.type === "commentary") return 1.8;
  if (item.priority >= 120) return 2.2;
  if (item.priority >= 80) return 2.8;
  return 3.6;
}

function adaptiveCurve(item: QueueItem): TimelineTransition["curve"] {
  if (item.type === "commentary") return "log";
  if (item.priority >= 100) return "exp";
  return "tri";
}

export function buildTimelineSnapshot(snapshot: DashboardSnapshot): TimelineSnapshot {
  const queue = snapshot.queue;
  const timelineNowSec = snapshot.streamStartedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.streamStartedAt).getTime()) / 1000))
    : 0;

  const arbitration: QueueArbitrationDecision[] = queue.map((q, idx) => ({
    segmentId: q.id,
    source: q.source,
    pinned: q.pinned,
    priority: q.priority,
    rank: idx + 1,
    reason: decideReason(q)
  }));

  const activeDeckClips: TimelineClip[] = [];
  const voiceoverOverlays: TimelineClip[] = [];

  let lookaheadOffset = 0;
  let currentDeck: "A" | "B" = "A";
  const transitions: TimelineTransition[] = [];

  if (snapshot.nowPlaying) {
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(snapshot.nowPlaying.startedAt).getTime()) / 1000));
    const remaining = Math.max(0, snapshot.nowPlaying.durationSec - elapsed);

    if (snapshot.nowPlaying.type === "commentary") {
      voiceoverOverlays.push({
        segmentId: snapshot.nowPlaying.id,
        type: "commentary",
        deck: "VO",
        startSec: 0,
        durationSec: remaining,
        notes: snapshot.nowPlaying.notes
      });
    } else {
      activeDeckClips.push({
        segmentId: snapshot.nowPlaying.id,
        type: snapshot.nowPlaying.type,
        deck: currentDeck,
        startSec: 0,
        durationSec: remaining,
        notes: snapshot.nowPlaying.notes
      });
      lookaheadOffset += remaining;
      currentDeck = currentDeck === "A" ? "B" : "A";
    }
  }

  for (let i = 0; i < queue.length; i += 1) {
    const q = queue[i];
    const isVoice = q.type === "commentary";
    const deck = isVoice ? "VO" : currentDeck;
    const explicitStart = typeof q.scheduledStartSec === "number"
      ? Math.max(0, q.scheduledStartSec - timelineNowSec)
      : null;
    const startSec = explicitStart ?? (isVoice ? Math.max(0, lookaheadOffset - 6) : lookaheadOffset);

    const clip: TimelineClip = {
      segmentId: q.id,
      type: q.type,
      deck,
      startSec,
      durationSec: q.durationSec,
      notes: q.notes
    };

    if (isVoice) {
      voiceoverOverlays.push(clip);
    } else {
      activeDeckClips.push(clip);
      lookaheadOffset = Math.max(lookaheadOffset, startSec + q.durationSec);
      const nxt = queue[i + 1];
      if (nxt && nxt.type !== "commentary") {
        const windowSec = adaptiveTransitionWindow(q);
        transitions.push({
          fromDeck: currentDeck,
          toDeck: currentDeck === "A" ? "B" : "A",
          startSec: Math.max(0, lookaheadOffset - windowSec),
          durationSec: windowSec,
          curve: adaptiveCurve(q),
          reason: "song_to_song"
        });
      }
      currentDeck = currentDeck === "A" ? "B" : "A";
    }
  }

  const elapsedSec = snapshot.streamStartedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.streamStartedAt).getTime()) / 1000))
    : 0;
  const currentSegmentElapsedSec = snapshot.nowPlaying
    ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.nowPlaying.startedAt).getTime()) / 1000))
    : 0;
  const currentSegmentRemainingSec = snapshot.nowPlaying
    ? Math.max(0, snapshot.nowPlaying.durationSec - currentSegmentElapsedSec)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    activeDeckClips,
    nextTransitions: transitions.slice(0, 8),
    voiceoverOverlays,
    masterPlayhead: {
      elapsedSec,
      currentSegmentElapsedSec,
      currentSegmentRemainingSec,
      timelineOffsetSec: elapsedSec
    },
    lookaheadSecCovered: lookaheadOffset,
    queueArbitration: arbitration
  };
}
