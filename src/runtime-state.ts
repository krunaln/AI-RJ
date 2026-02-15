import type {
  AudioMeterState,
  DeckId,
  DashboardEvent,
  DashboardSnapshot,
  QueueItem,
  QueueSource,
  RenderedSegment,
  SegmentHistoryItem,
  SegmentType,
  SystemErrorItem
} from "./types";

const MAX_RECENT_EVENTS = 200;
const MAX_RECENT_SEGMENTS = 50;
const MAX_RECENT_ERRORS = 50;

type Listener = (event: DashboardEvent) => void;

function trimNewest<T>(items: T[], max: number): T[] {
  return items.slice(0, max);
}

function sortQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
  });
}

function emptyStats(): DashboardSnapshot["stats"] {
  return {
    segmentsByType: {
      songs: 0,
      commentary: 0,
      liner: 0
    },
    generationFailures: 0,
    fallbackLinerCount: 0,
    youtubeFetchErrors: 0,
    ttsFailures: 0
  };
}

function emptyMeters(): AudioMeterState {
  return {
    music: 0,
    voice: 0,
    jingle: 0,
    ads: 0,
    master: 0
  };
}

function cloneSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as DashboardSnapshot;
}

export class RuntimeState {
  private listeners = new Set<Listener>();

  private snapshotState: DashboardSnapshot = {
    running: false,
    streamStartedAt: null,
    phase: "songs",
    tracksLoaded: 0,
    bufferedSec: 0,
    lastError: null,
    nowPlaying: null,
    queue: [],
    recentSegments: [],
    recentEvents: [],
    recentErrors: [],
    publisher: {
      connected: false,
      reconnects: 0,
      lastExitCode: null,
      lastFfmpegLine: null
    },
    stats: emptyStats(),
    masterPlayhead: {
      elapsedSec: 0,
      currentSegmentElapsedSec: 0,
      currentSegmentRemainingSec: 0,
      timelineOffsetSec: 0
    },
    deckA: {
      deck: "A",
      activeSegmentId: null,
      activeType: null,
      positionSec: 0,
      remainingSec: 0,
      nextSegmentId: null
    },
    deckB: {
      deck: "B",
      activeSegmentId: null,
      activeType: null,
      positionSec: 0,
      remainingSec: 0,
      nextSegmentId: null
    },
    voiceoverLane: {
      active: false,
      segmentId: null,
      positionSec: 0,
      remainingSec: 0
    },
    crossfader: {
      active: false,
      fromDeck: null,
      toDeck: null,
      position: 0,
      curve: "tri",
      windowSec: 0,
      transitionStartTs: null
    },
    ducking: {
      active: false,
      reductionDb: 0
    },
    lookaheadSecCovered: 0,
    meters: emptyMeters()
  };
  private lastMusicDeck: DeckId = "B";

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DashboardSnapshot {
    this.refreshTransportFields();
    return cloneSnapshot(this.snapshotState);
  }

  setCore(partial: Partial<Pick<DashboardSnapshot, "running" | "phase" | "tracksLoaded" | "bufferedSec" | "lastError">>): void {
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(partial)) {
      if ((this.snapshotState as Record<string, unknown>)[key] !== value) {
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length === 0) {
      return;
    }
    this.snapshotState = {
      ...this.snapshotState,
      ...(changed as typeof partial)
    };
    this.emit("state.updated", changed);
  }

  publisherStarted(rtmpUrl: string): void {
    this.snapshotState.publisher.connected = true;
    if (!this.snapshotState.streamStartedAt) {
      this.snapshotState.streamStartedAt = new Date().toISOString();
    }
    this.emit("publisher.started", { rtmpUrl });
  }

  publisherStopped(): void {
    this.snapshotState.publisher.connected = false;
    this.snapshotState.streamStartedAt = null;
    this.emit("publisher.stopped", {});
  }

  publisherError(message: string, exitCode?: number | null): void {
    this.snapshotState.publisher.connected = false;
    this.snapshotState.publisher.reconnects += 1;
    this.snapshotState.publisher.lastExitCode = exitCode ?? null;
    this.recordError("publisher", message);
    this.emit("publisher.error", { message, exitCode: exitCode ?? null });
  }

  publisherLine(line: string): void {
    this.snapshotState.publisher.lastFfmpegLine = line;
    this.emit("publisher.ffmpeg", { line });
  }

  markBuildStarted(phase: DashboardSnapshot["phase"]): void {
    this.emit("segment.build.started", { phase });
  }

  markBuildFailed(error: string): void {
    this.snapshotState.stats.generationFailures += 1;
    this.snapshotState.lastError = error;
    this.recordError("segment.build", error);
    this.emit("segment.build.failed", { error });
  }

  markYoutubeError(error: string): void {
    this.snapshotState.stats.youtubeFetchErrors += 1;
    this.recordError("youtube", error);
  }

  markTtsError(error: string): void {
    this.snapshotState.stats.ttsFailures += 1;
    this.recordError("tts", error);
  }

  markCommentaryGenerated(chars: number): void {
    this.emit("commentary.generated", { chars });
  }

  markCommentaryFallback(reason: string): void {
    this.snapshotState.stats.fallbackLinerCount += 1;
    this.emit("commentary.fallback", { reason });
  }

  enqueueSegment(segment: RenderedSegment, bufferedSec: number): void {
    const item: QueueItem = {
      ...segment,
      enqueuedAt: new Date().toISOString(),
      source: (segment.source || "auto") as QueueSource,
      priority: typeof segment.priority === "number" ? segment.priority : segment.source === "manual" ? 100 : 50,
      pinned: Boolean(segment.pinned)
    };
    this.snapshotState.queue = sortQueue([...this.snapshotState.queue, item]);
    this.snapshotState.bufferedSec = bufferedSec;
    this.refreshTransportFields();
    this.emit("segment.enqueued", { segment: item, bufferedSec });
    this.emit("timeline.updated", { lookaheadSecCovered: this.snapshotState.lookaheadSecCovered });
    this.emit("queue.arbitrated", { queue: this.snapshotState.queue.map((q) => ({ id: q.id, source: q.source, priority: q.priority, pinned: q.pinned })) });
  }

  segmentStarted(segmentId: string): void {
    const idx = this.snapshotState.queue.findIndex((q) => q.id === segmentId);
    if (idx === -1) {
      return;
    }

    const queueItem = this.snapshotState.queue.splice(idx, 1)[0];
    const active: SegmentHistoryItem = {
      id: queueItem.id,
      type: queueItem.type,
      notes: queueItem.notes,
      durationSec: queueItem.durationSec,
      startedAt: new Date().toISOString(),
      filePath: queueItem.filePath,
      commentaryText: queueItem.commentaryText,
      channel: queueItem.channel,
      scheduledStartSec: queueItem.scheduledStartSec
    };

    this.snapshotState.nowPlaying = active;
    if (active.type === "commentary") {
      this.snapshotState.voiceoverLane = {
        active: true,
        segmentId: active.id,
        positionSec: 0,
        remainingSec: active.durationSec
      };
      this.snapshotState.ducking = { active: true, reductionDb: 12 };
    } else {
      const nextDeck: DeckId = this.lastMusicDeck === "A" ? "B" : "A";
      this.lastMusicDeck = nextDeck;
      const deckState = {
        deck: nextDeck,
        activeSegmentId: active.id,
        activeType: active.type,
        positionSec: 0,
        remainingSec: active.durationSec,
        nextSegmentId: this.snapshotState.queue.find((q) => q.type !== "commentary")?.id || null
      };
      if (nextDeck === "A") this.snapshotState.deckA = deckState;
      else this.snapshotState.deckB = deckState;
      this.snapshotState.crossfader = {
        active: true,
        fromDeck: nextDeck === "A" ? "B" : "A",
        toDeck: nextDeck,
        position: 0.5,
        curve: "exp",
        windowSec: 3.2,
        transitionStartTs: new Date().toISOString()
      };
      this.emit("crossfader.state.changed", this.snapshotState.crossfader as unknown as Record<string, unknown>);
    }
    this.refreshTransportFields();
    this.emit("segment.started", { segment: active });
    if (active.type === "commentary") this.emit("voiceover.started", { segmentId: active.id });
    else this.emit("deck.state.changed", { deck: this.lastMusicDeck, segmentId: active.id });
  }

  segmentFinished(segmentId: string, bufferedSec: number): void {
    const now = this.snapshotState.nowPlaying;
    if (!now || now.id !== segmentId) {
      this.snapshotState.bufferedSec = bufferedSec;
      this.emit("state.updated", { bufferedSec });
      return;
    }

    const finished: SegmentHistoryItem = {
      ...now,
      finishedAt: new Date().toISOString()
    };
    this.snapshotState.nowPlaying = null;
    this.snapshotState.bufferedSec = bufferedSec;
    this.snapshotState.recentSegments = trimNewest([finished, ...this.snapshotState.recentSegments], MAX_RECENT_SEGMENTS);
    this.snapshotState.stats.segmentsByType[finished.type as SegmentType] += 1;

    if (finished.type === "commentary") {
      this.snapshotState.voiceoverLane = {
        active: false,
        segmentId: null,
        positionSec: 0,
        remainingSec: 0
      };
      this.snapshotState.ducking = { active: false, reductionDb: 0 };
      this.emit("voiceover.ended", { segmentId: finished.id });
    }
    this.refreshTransportFields();
    this.emit("segment.finished", { segment: finished, bufferedSec });
    this.emit("timeline.updated", { lookaheadSecCovered: this.snapshotState.lookaheadSecCovered });
    this.emit("transport.progress", {
      elapsedSec: this.snapshotState.masterPlayhead.elapsedSec,
      lookaheadSecCovered: this.snapshotState.lookaheadSecCovered
    });
  }

  removeQueuedSegment(segmentId: string, bufferedSec: number): boolean {
    const idx = this.snapshotState.queue.findIndex((q) => q.id === segmentId);
    if (idx === -1) {
      return false;
    }
    const [removed] = this.snapshotState.queue.splice(idx, 1);
    this.snapshotState.bufferedSec = bufferedSec;
    this.refreshTransportFields();
    this.emit("queue.removed", { segmentId: removed.id, bufferedSec });
    this.emit("timeline.updated", { lookaheadSecCovered: this.snapshotState.lookaheadSecCovered });
    this.emit("queue.arbitrated", { queue: this.snapshotState.queue.map((q) => ({ id: q.id, source: q.source, priority: q.priority, pinned: q.pinned })) });
    return true;
  }

  updateQueuedSegment(
    segmentId: string,
    patch: { priority?: number; pinned?: boolean },
    bufferedSec: number
  ): QueueItem | null {
    const idx = this.snapshotState.queue.findIndex((q) => q.id === segmentId);
    if (idx === -1) {
      return null;
    }

    const existing = this.snapshotState.queue[idx];
    const next: QueueItem = {
      ...existing,
      priority: typeof patch.priority === "number" ? patch.priority : existing.priority,
      pinned: typeof patch.pinned === "boolean" ? patch.pinned : existing.pinned
    };
    this.snapshotState.queue[idx] = next;
    this.snapshotState.queue = sortQueue(this.snapshotState.queue);
    this.snapshotState.bufferedSec = bufferedSec;
    this.refreshTransportFields();
    this.emit("queue.updated", { segment: next, bufferedSec });
    this.emit("timeline.updated", { lookaheadSecCovered: this.snapshotState.lookaheadSecCovered });
    this.emit("queue.arbitrated", { queue: this.snapshotState.queue.map((q) => ({ id: q.id, source: q.source, priority: q.priority, pinned: q.pinned })) });
    return next;
  }

  getMediaPath(segmentId: string): string | null {
    const queueHit = this.snapshotState.queue.find((q) => q.id === segmentId);
    if (queueHit) return queueHit.filePath;

    if (this.snapshotState.nowPlaying?.id === segmentId) {
      return this.snapshotState.nowPlaying.filePath;
    }

    const recentHit = this.snapshotState.recentSegments.find((s) => s.id === segmentId);
    if (recentHit) return recentHit.filePath;

    return null;
  }

  private recordError(source: string, message: string): void {
    const error: SystemErrorItem = {
      ts: new Date().toISOString(),
      source,
      message
    };
    this.snapshotState.recentErrors = trimNewest([error, ...this.snapshotState.recentErrors], MAX_RECENT_ERRORS);
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    const compact: DashboardEvent = {
      ts: new Date().toISOString(),
      event,
      payload
    };

    this.snapshotState.recentEvents = trimNewest([compact, ...this.snapshotState.recentEvents], MAX_RECENT_EVENTS);

    const out: DashboardEvent = {
      ...compact,
      snapshot: this.snapshot()
    };

    for (const listener of this.listeners) {
      listener(out);
    }
  }

  markSkipRequested(): void {
    this.emit("transport.skip.requested", {});
  }

  markSkipCompleted(): void {
    this.emit("transport.skip.completed", {});
  }

  markSchedulerRebuild(stage: "started" | "done" | "failed", reason: string): void {
    this.emit(`scheduler.rebuild.${stage}`, { reason });
  }

  setMeters(next: AudioMeterState): void {
    const cur = this.snapshotState.meters;
    const delta =
      Math.abs(cur.music - next.music) +
      Math.abs(cur.voice - next.voice) +
      Math.abs(cur.jingle - next.jingle) +
      Math.abs(cur.ads - next.ads) +
      Math.abs(cur.master - next.master);
    if (delta < 0.02) {
      return;
    }
    this.snapshotState.meters = next;
    this.emit("mixer.meters", { meters: next });
  }

  private refreshTransportFields(): void {
    const elapsedSec = this.snapshotState.streamStartedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(this.snapshotState.streamStartedAt).getTime()) / 1000))
      : 0;
    const segElapsed = this.snapshotState.nowPlaying
      ? Math.max(0, Math.floor((Date.now() - new Date(this.snapshotState.nowPlaying.startedAt).getTime()) / 1000))
      : 0;
    const segRemaining = this.snapshotState.nowPlaying
      ? Math.max(0, this.snapshotState.nowPlaying.durationSec - segElapsed)
      : 0;
    this.snapshotState.masterPlayhead = {
      elapsedSec,
      currentSegmentElapsedSec: segElapsed,
      currentSegmentRemainingSec: segRemaining,
      timelineOffsetSec: elapsedSec
    };
    this.snapshotState.lookaheadSecCovered = this.snapshotState.queue.reduce((acc, q) => acc + q.durationSec, 0);

    if (this.snapshotState.voiceoverLane.active && this.snapshotState.nowPlaying?.type === "commentary") {
      this.snapshotState.voiceoverLane.positionSec = segElapsed;
      this.snapshotState.voiceoverLane.remainingSec = segRemaining;
    }
    if (this.snapshotState.deckA.activeSegmentId && this.lastMusicDeck === "A" && this.snapshotState.nowPlaying && this.snapshotState.nowPlaying.id === this.snapshotState.deckA.activeSegmentId) {
      this.snapshotState.deckA.positionSec = segElapsed;
      this.snapshotState.deckA.remainingSec = segRemaining;
    }
    if (this.snapshotState.deckB.activeSegmentId && this.lastMusicDeck === "B" && this.snapshotState.nowPlaying && this.snapshotState.nowPlaying.id === this.snapshotState.deckB.activeSegmentId) {
      this.snapshotState.deckB.positionSec = segElapsed;
      this.snapshotState.deckB.remainingSec = segRemaining;
    }
  }
}
