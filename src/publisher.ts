import { log, logError } from "./log";
import type { RenderedSegment } from "./types";
import { RtmpSink } from "./rtmp-sink";

type QueueItem = {
  segment: RenderedSegment;
  enqueuedAtMs: number;
};

type PublisherHooks = {
  onStarted?: (rtmpUrl: string) => void;
  onStopped?: () => void;
  onError?: (message: string, exitCode?: number | null) => void;
  onFfmpegLine?: (line: string) => void;
  onSegmentStarted?: (segmentId: string) => void;
  onSegmentFinished?: (segmentId: string, bufferedSec: number) => void;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RtmpPublisher {
  private queue: QueueItem[] = [];
  private running = false;
  private processing = false;
  private bufferedSec = 0;
  private readonly sink: RtmpSink;

  constructor(
    workDir: string,
    rtmpUrl: string,
    private readonly hooks: PublisherHooks = {}
  ) {
    this.sink = new RtmpSink(workDir, rtmpUrl, {
      onStarted: hooks.onStarted,
      onStopped: hooks.onStopped,
      onError: hooks.onError,
      onFfmpegLine: hooks.onFfmpegLine
    });
  }

  getBufferedSec(): number {
    return this.bufferedSec;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.sink.start();
    this.running = true;
    this.processLoop().catch((err) => logError("publisher.loop.error", err));
    log("publisher.started", {});
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue = [];
    this.bufferedSec = 0;
    await this.sink.stop();
    log("publisher.stopped");
  }

  enqueue(segment: RenderedSegment): void {
    this.queue.push({ segment, enqueuedAtMs: Date.now() });
    this.queue.sort((a, b) => {
      const aPinned = Boolean(a.segment.pinned);
      const bPinned = Boolean(b.segment.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aPriority = typeof a.segment.priority === "number" ? a.segment.priority : a.segment.source === "manual" ? 100 : 50;
      const bPriority = typeof b.segment.priority === "number" ? b.segment.priority : b.segment.source === "manual" ? 100 : 50;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return a.enqueuedAtMs - b.enqueuedAtMs;
    });
    this.bufferedSec += segment.durationSec;
  }

  removeQueuedSegment(segmentId: string): boolean {
    const idx = this.queue.findIndex((q) => q.segment.id === segmentId);
    if (idx === -1) {
      return false;
    }
    const [removed] = this.queue.splice(idx, 1);
    this.bufferedSec = Math.max(0, this.bufferedSec - removed.segment.durationSec);
    return true;
  }

  updateQueuedSegment(segmentId: string, patch: { priority?: number; pinned?: boolean }): boolean {
    const idx = this.queue.findIndex((q) => q.segment.id === segmentId);
    if (idx === -1) {
      return false;
    }
    const cur = this.queue[idx];
    cur.segment = {
      ...cur.segment,
      priority: typeof patch.priority === "number" ? patch.priority : cur.segment.priority,
      pinned: typeof patch.pinned === "boolean" ? patch.pinned : cur.segment.pinned
    };
    this.queue.sort((a, b) => {
      const aPinned = Boolean(a.segment.pinned);
      const bPinned = Boolean(b.segment.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aPriority = typeof a.segment.priority === "number" ? a.segment.priority : a.segment.source === "manual" ? 100 : 50;
      const bPriority = typeof b.segment.priority === "number" ? b.segment.priority : b.segment.source === "manual" ? 100 : 50;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return a.enqueuedAtMs - b.enqueuedAtMs;
    });
    return true;
  }

  skipCurrentSegment(): boolean {
    return this.sink.abortCurrentPush();
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.running) {
      const next = this.queue.shift();
      if (!next) {
        await wait(300);
        continue;
      }

      try {
        this.hooks.onSegmentStarted?.(next.segment.id);
        await this.sink.pushFile(next.segment.filePath);
      } catch (error) {
        logError("publisher.stream.error", error, { filePath: next.segment.filePath });
        this.hooks.onError?.(
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.bufferedSec = Math.max(0, this.bufferedSec - next.segment.durationSec);
        this.hooks.onSegmentFinished?.(next.segment.id, this.bufferedSec);
      }
    }

    this.processing = false;
  }
}
