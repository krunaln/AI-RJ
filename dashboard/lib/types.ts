export type SegmentType = "songs" | "commentary" | "liner";
export type QueueSource = "auto" | "manual";
export type DeckId = "A" | "B";

export type QueueItem = {
  id: string;
  type: SegmentType;
  filePath: string;
  durationSec: number;
  notes: string;
  enqueuedAt: string;
  commentaryText?: string;
  source: QueueSource;
  priority: number;
  pinned: boolean;
};

export type SegmentHistoryItem = {
  id: string;
  type: SegmentType;
  notes: string;
  durationSec: number;
  startedAt: string;
  finishedAt?: string;
  filePath: string;
  commentaryText?: string;
};

export type SystemErrorItem = {
  ts: string;
  source: string;
  message: string;
};

export type DashboardEvent = {
  ts: string;
  event: string;
  payload: Record<string, unknown>;
  snapshot?: DashboardSnapshot;
};

export type TimelineClip = {
  segmentId: string;
  type: SegmentType;
  deck: DeckId | "VO";
  startSec: number;
  durationSec: number;
  notes: string;
};

export type TimelineSnapshot = {
  generatedAt: string;
  activeDeckClips: TimelineClip[];
  nextTransitions: Array<{
    fromDeck: DeckId;
    toDeck: DeckId;
    startSec: number;
    durationSec: number;
    curve: "tri" | "exp" | "log";
    reason: "song_to_song" | "song_to_commentary" | "commentary_to_song";
  }>;
  voiceoverOverlays: TimelineClip[];
  masterPlayhead: {
    elapsedSec: number;
    currentSegmentElapsedSec: number;
    currentSegmentRemainingSec: number;
    timelineOffsetSec: number;
  };
  lookaheadSecCovered: number;
  queueArbitration: Array<{
    segmentId: string;
    source: QueueSource;
    pinned: boolean;
    priority: number;
    rank: number;
    reason: "manual_pinned" | "manual_priority" | "auto_priority";
  }>;
};

export type DashboardSnapshot = {
  running: boolean;
  streamStartedAt: string | null;
  phase: "songs" | "commentary";
  tracksLoaded: number;
  bufferedSec: number;
  lastError: string | null;
  nowPlaying: SegmentHistoryItem | null;
  queue: QueueItem[];
  recentSegments: SegmentHistoryItem[];
  recentEvents: DashboardEvent[];
  recentErrors: SystemErrorItem[];
  publisher: {
    connected: boolean;
    reconnects: number;
    lastExitCode: number | null;
    lastFfmpegLine: string | null;
  };
  stats: {
    segmentsByType: Record<SegmentType, number>;
    generationFailures: number;
    fallbackLinerCount: number;
    youtubeFetchErrors: number;
    ttsFailures: number;
  };
  masterPlayhead: {
    elapsedSec: number;
    currentSegmentElapsedSec: number;
    currentSegmentRemainingSec: number;
    timelineOffsetSec: number;
  };
  deckA: {
    deck: DeckId;
    activeSegmentId: string | null;
    activeType: SegmentType | null;
    positionSec: number;
    remainingSec: number;
    nextSegmentId: string | null;
  };
  deckB: {
    deck: DeckId;
    activeSegmentId: string | null;
    activeType: SegmentType | null;
    positionSec: number;
    remainingSec: number;
    nextSegmentId: string | null;
  };
  voiceoverLane: {
    active: boolean;
    segmentId: string | null;
    positionSec: number;
    remainingSec: number;
  };
  crossfader: {
    active: boolean;
    fromDeck: DeckId | null;
    toDeck: DeckId | null;
    position: number;
    curve: "tri" | "exp" | "log";
    windowSec: number;
    transitionStartTs: string | null;
  };
  ducking: {
    active: boolean;
    reductionDb: number;
  };
  lookaheadSecCovered: number;
};
