export type Track = {
  id: string;
  title: string;
  artist: string;
  youtube_url: string;
  duration_sec: number;
  tags: string[];
  energy: number;
  mood: string;
  language: string;
};

export type SegmentType = "songs" | "commentary" | "liner";
export type QueueSource = "auto" | "manual";
export type DeckId = "A" | "B";

export type RenderedSegment = {
  id: string;
  type: SegmentType;
  filePath: string;
  durationSec: number;
  notes: string;
  commentaryText?: string;
  source?: QueueSource;
  priority?: number;
  pinned?: boolean;
};

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

export type DashboardStats = {
  segmentsByType: Record<SegmentType, number>;
  generationFailures: number;
  fallbackLinerCount: number;
  youtubeFetchErrors: number;
  ttsFailures: number;
};

export type PublisherStatus = {
  connected: boolean;
  reconnects: number;
  lastExitCode: number | null;
  lastFfmpegLine: string | null;
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
  publisher: PublisherStatus;
  stats: DashboardStats;
  masterPlayhead: MasterTransportState;
  deckA: DeckState;
  deckB: DeckState;
  voiceoverLane: VoiceoverState;
  crossfader: CrossfaderState;
  ducking: DuckingState;
  lookaheadSecCovered: number;
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

export type TimelineTransition = {
  fromDeck: DeckId;
  toDeck: DeckId;
  startSec: number;
  durationSec: number;
  curve: "tri" | "exp" | "log";
  reason: "song_to_song" | "song_to_commentary" | "commentary_to_song";
};

export type DeckState = {
  deck: DeckId;
  activeSegmentId: string | null;
  activeType: SegmentType | null;
  positionSec: number;
  remainingSec: number;
  nextSegmentId: string | null;
};

export type VoiceoverState = {
  active: boolean;
  segmentId: string | null;
  positionSec: number;
  remainingSec: number;
};

export type MasterTransportState = {
  elapsedSec: number;
  currentSegmentElapsedSec: number;
  currentSegmentRemainingSec: number;
  timelineOffsetSec: number;
};

export type QueueArbitrationDecision = {
  segmentId: string;
  source: QueueSource;
  pinned: boolean;
  priority: number;
  rank: number;
  reason: "manual_pinned" | "manual_priority" | "auto_priority";
};

export type CrossfaderState = {
  active: boolean;
  fromDeck: DeckId | null;
  toDeck: DeckId | null;
  position: number;
  curve: "tri" | "exp" | "log";
  windowSec: number;
  transitionStartTs: string | null;
};

export type DuckingState = {
  active: boolean;
  reductionDb: number;
};

export type TimelineSnapshot = {
  generatedAt: string;
  activeDeckClips: TimelineClip[];
  nextTransitions: TimelineTransition[];
  voiceoverOverlays: TimelineClip[];
  masterPlayhead: MasterTransportState;
  lookaheadSecCovered: number;
  queueArbitration: QueueArbitrationDecision[];
};
