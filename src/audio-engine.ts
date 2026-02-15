import { makeOutFile, silenceFile } from "./audio";
import { logError } from "./log";
import { RtmpSink } from "./rtmp-sink";
import { renderTimeline, type TimelineClip } from "./timeline";
import type { AudioChannel, AudioMeterState } from "./types";

export type ScheduledClip = {
  id: string;
  channel: AudioChannel;
  filePath: string;
  startAtSec: number;
  offsetSec?: number;
  durationSec: number;
  gain?: number;
  gainFrom?: number;
  gainTo?: number;
  gainRampSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  segmentId?: string;
};

type ClipRecord = ScheduledClip & {
  endAtSec: number;
  started: boolean;
  finished: boolean;
};

type AudioEngineHooks = {
  onStarted?: (rtmpUrl: string) => void;
  onStopped?: () => void;
  onError?: (message: string, exitCode?: number | null) => void;
  onFfmpegLine?: (line: string) => void;
  onSegmentStarted?: (segmentId: string) => void;
  onSegmentFinished?: (segmentId: string, bufferedSec: number) => void;
};

export class AudioEngine {
  private readonly sink: RtmpSink;
  private readonly clips: ClipRecord[] = [];
  private running = false;
  private streamStartMs: number | null = null;
  private outputHorizonSec = 0;
  private renderInFlight: Promise<void> | null = null;

  constructor(
    private readonly workDir: string,
    rtmpUrl: string,
    private readonly hooks: AudioEngineHooks = {},
    private readonly chunkSec = 2
  ) {
    this.sink = new RtmpSink(workDir, rtmpUrl, {
      onStarted: hooks.onStarted,
      onStopped: hooks.onStopped,
      onError: hooks.onError,
      onFfmpegLine: hooks.onFfmpegLine
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.sink.start();
    this.running = true;
    this.streamStartMs = Date.now();
    this.outputHorizonSec = 0;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.streamStartMs = null;
    this.outputHorizonSec = 0;
    this.clips.splice(0, this.clips.length);
    await this.sink.stop();
  }

  nowSec(): number {
    if (!this.streamStartMs) return 0;
    return Math.max(0, (Date.now() - this.streamStartMs) / 1000);
  }

  bufferedSec(): number {
    return Math.max(0, this.outputHorizonSec - this.nowSec());
  }

  scheduleHorizonSec(): number {
    return this.clips.reduce((acc, c) => Math.max(acc, c.endAtSec), 0);
  }

  getMeters(nowSec = this.nowSec()): AudioMeterState {
    const raw = {
      music: 0,
      voice: 0,
      jingle: 0,
      ads: 0
    } satisfies Record<AudioChannel, number>;

    for (const clip of this.clips) {
      if (clip.finished) continue;
      if (nowSec < clip.startAtSec || nowSec >= clip.endAtSec) continue;
      const gain = Math.max(0, clip.gain ?? 1);
      const level = this.levelAt(clip, nowSec) * gain;
      raw[clip.channel] = Math.max(raw[clip.channel], Math.min(1, level));
    }

    const master = Math.min(1, Math.sqrt(
      raw.music * raw.music +
      raw.voice * raw.voice +
      raw.jingle * raw.jingle +
      raw.ads * raw.ads
    ));

    return {
      ...raw,
      master
    };
  }

  addClip(clip: ScheduledClip): void {
    const durationSec = Math.max(0.05, clip.durationSec);
    const record: ClipRecord = {
      ...clip,
      durationSec,
      offsetSec: Math.max(0, clip.offsetSec || 0),
      endAtSec: clip.startAtSec + durationSec,
      started: false,
      finished: false
    };
    this.clips.push(record);
    this.clips.sort((a, b) => a.startAtSec - b.startAtSec);
  }

  removeClip(clipId: string): boolean {
    const idx = this.clips.findIndex((c) => c.id === clipId && !c.started);
    if (idx === -1) return false;
    this.clips.splice(idx, 1);
    return true;
  }

  syncLifecycle(): void {
    const now = this.nowSec();
    for (const clip of this.clips) {
      const segmentId = clip.segmentId || clip.id;
      if (!clip.started && now >= clip.startAtSec) {
        clip.started = true;
        this.hooks.onSegmentStarted?.(segmentId);
      }
      if (!clip.finished && now >= clip.endAtSec) {
        clip.finished = true;
        this.hooks.onSegmentFinished?.(segmentId, this.bufferedSec());
      }
    }

    for (let i = this.clips.length - 1; i >= 0; i -= 1) {
      if (this.clips[i].finished && now > this.clips[i].endAtSec + 4) {
        this.clips.splice(i, 1);
      }
    }
  }

  async renderAndPushUntil(minBufferedSec: number): Promise<void> {
    if (!this.running) {
      throw new Error("AudioEngine is not running");
    }

    if (this.renderInFlight) {
      return this.renderInFlight;
    }

    this.renderInFlight = this.renderLoop(minBufferedSec)
      .catch((error) => {
        logError("audioengine.render.error", error);
        throw error;
      })
      .finally(() => {
        this.renderInFlight = null;
      });

    return this.renderInFlight;
  }

  private async renderLoop(minBufferedSec: number): Promise<void> {
    while (this.running && this.bufferedSec() < minBufferedSec) {
      const chunkStart = this.outputHorizonSec;
      const chunkDuration = this.chunkSec;
      const chunkEnd = chunkStart + chunkDuration;
      const overlapping = this.collectOverlappingClips(chunkStart, chunkEnd);
      const out = makeOutFile(this.workDir, "engine-chunk");

      if (!overlapping.length) {
        await silenceFile(out, chunkDuration);
      } else {
        await renderTimeline(overlapping, out, { master: false });
      }

      await this.sink.pushFile(out);
      this.outputHorizonSec += chunkDuration;
      this.syncLifecycle();
    }
  }

  private collectOverlappingClips(chunkStart: number, chunkEnd: number): TimelineClip[] {
    const clips: TimelineClip[] = [];

    for (const clip of this.clips) {
      if (clip.endAtSec <= chunkStart) continue;
      if (clip.startAtSec >= chunkEnd) continue;

      const audibleStart = Math.max(chunkStart, clip.startAtSec);
      const audibleEnd = Math.min(chunkEnd, clip.endAtSec);
      const audibleDuration = Math.max(0.02, audibleEnd - audibleStart);

      const startInChunk = Math.max(0, clip.startAtSec - chunkStart);
      const sourceOffset = (clip.offsetSec || 0) + Math.max(0, chunkStart - clip.startAtSec);
      const clipElapsedStart = Math.max(0, chunkStart - clip.startAtSec);
      const clipElapsedEnd = Math.max(0, chunkEnd - clip.startAtSec);
      const gainStart = this.gainAt(clip, clipElapsedStart);
      const gainEnd = this.gainAt(clip, clipElapsedEnd);

      clips.push({
        filePath: clip.filePath,
        startSec: startInChunk,
        sourceOffsetSec: sourceOffset,
        durationSec: audibleDuration,
        gain: clip.gain,
        gainStart,
        gainEnd,
        gainRampSec: audibleDuration
      });
    }

    return clips;
  }

  private levelAt(clip: ClipRecord, nowSec: number): number {
    const elapsed = nowSec - clip.startAtSec;
    const remain = clip.endAtSec - nowSec;
    let v = 1;
    const fadeIn = Math.max(0, clip.fadeInSec || 0);
    const fadeOut = Math.max(0, clip.fadeOutSec || 0);
    if (fadeIn > 0) {
      v = Math.min(v, Math.max(0, Math.min(1, elapsed / fadeIn)));
    }
    if (fadeOut > 0) {
      v = Math.min(v, Math.max(0, Math.min(1, remain / fadeOut)));
    }
    return v;
  }

  private gainAt(clip: ClipRecord, elapsedSec: number): number {
    const base = Math.max(0, clip.gain ?? 1);
    const from = Math.max(0, clip.gainFrom ?? base);
    const to = Math.max(0, clip.gainTo ?? base);
    const rampSec = Math.max(0.05, clip.gainRampSec ?? clip.durationSec);
    const t = Math.max(0, Math.min(1, elapsedSec / rampSec));
    return from + ((to - from) * t);
  }
}
