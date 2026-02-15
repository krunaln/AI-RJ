import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config";
import type { AudioChannel, RenderedSegment, Track } from "./types";
import { loadCatalog } from "./catalog";
import { YouTubeAudioService } from "./youtube";
import { CommentaryService } from "./llm";
import { TTSClient } from "./tts";
import { RtmpPublisher } from "./publisher";
import { applyEdgeFades, enhanceCommentaryVoice, getDurationSec, makeOutFile, prependStationId, silenceFile } from "./audio";
import { log, logError } from "./log";
import { RuntimeState } from "./runtime-state";
import { buildTimelineSnapshot } from "./timeline-engine";
import type { TimelineSnapshot } from "./types";
import { AudioEngine } from "./audio-engine";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Orchestrator {
  private tracks: Track[] = [];
  private running = false;
  private shuffledTrackOrder: number[] = [];
  private shuffledPtr = 0;
  private phase: "songs" | "commentary" = "songs";
  private lastPlayed: Track[] = [];
  private lastError = "";
  private songsSinceCommentary = 0;
  private readonly runtime = new RuntimeState();
  private stationIdAvailable = false;
  private stationIdDurationSec = 0;
  private scheduleCursorSec = 0;
  private lastScheduledSegment: { type: RenderedSegment["type"]; startAtSec: number; durationSec: number } | null = null;
  private lastMeterPushMs = 0;

  private readonly yt = new YouTubeAudioService(appConfig.workDir);
  private readonly commentary = new CommentaryService(appConfig.groqApiKey, appConfig.groqModel, appConfig.persona);
  private readonly tts = new TTSClient(appConfig.ttsBaseUrl);
  private readonly useAudioEngine = appConfig.audioEngineV2;
  private readonly publisher = new RtmpPublisher(appConfig.workDir, appConfig.rtmpUrl, {
    onStarted: (rtmpUrl) => this.runtime.publisherStarted(rtmpUrl),
    onStopped: () => this.runtime.publisherStopped(),
    onError: (message, code) => this.runtime.publisherError(message, code),
    onFfmpegLine: (line) => this.runtime.publisherLine(line),
    onSegmentStarted: (segmentId) => this.runtime.segmentStarted(segmentId),
    onSegmentFinished: (segmentId, bufferedSec) => this.runtime.segmentFinished(segmentId, bufferedSec)
  });
  private readonly audioEngine = new AudioEngine(appConfig.workDir, appConfig.rtmpUrl, {
    onStarted: (rtmpUrl) => this.runtime.publisherStarted(rtmpUrl),
    onStopped: () => this.runtime.publisherStopped(),
    onError: (message, code) => this.runtime.publisherError(message, code),
    onFfmpegLine: (line) => this.runtime.publisherLine(line),
    onSegmentStarted: (segmentId) => this.runtime.segmentStarted(segmentId),
    onSegmentFinished: (segmentId, bufferedSec) => this.runtime.segmentFinished(segmentId, bufferedSec)
  });

  getRuntimeState(): RuntimeState {
    return this.runtime;
  }

  async enqueueManualCommentary(text: string): Promise<RenderedSegment> {
    await this.yt.init();
    const raw = makeOutFile(appConfig.workDir, "manual-talk-raw");
    const voiced = makeOutFile(appConfig.workDir, "manual-talk");

    await this.tts.synthToFile(text, raw);
    await enhanceCommentaryVoice(raw, voiced);

    let finalCommentary = voiced;
    if (this.stationIdAvailable && !this.useAudioEngine) {
      const withId = makeOutFile(appConfig.workDir, "manual-talk-id");
      await prependStationId(appConfig.stationIdPath, voiced, withId);
      finalCommentary = withId;
    }

    const durationSec = await getDurationSec(finalCommentary);
    const seg: RenderedSegment = {
      id: `manual-talk-${Date.now()}`,
      type: "commentary",
      filePath: finalCommentary,
      durationSec,
      notes: text,
      commentaryText: text,
      source: "manual",
      priority: 120,
      pinned: true
    };

    await this.enqueueSegmentForOutput(seg);
    return seg;
  }

  async enqueueManualTrack(input: { title: string; artist?: string; youtube_url: string }): Promise<RenderedSegment> {
    await this.yt.init();
    const track: Track = {
      id: `manual-track-${Date.now()}`,
      title: input.title,
      artist: input.artist || "Unknown Artist",
      youtube_url: input.youtube_url,
      duration_sec: 180,
      tags: ["manual"],
      energy: 0.5,
      mood: "custom",
      language: "en"
    };
    const filePath = await this.yt.fetchTrackWav(track);
    const durationSec = await getDurationSec(filePath);
    const seg: RenderedSegment = {
      id: `manual-song-${Date.now()}`,
      type: "songs",
      filePath,
      durationSec,
      notes: `${track.title} - ${track.artist}`,
      source: "manual",
      priority: 110,
      pinned: true
    };

    await this.enqueueSegmentForOutput(seg);
    return seg;
  }

  removeQueuedSegment(segmentId: string): boolean {
    const removed = this.useAudioEngine
      ? this.audioEngine.removeClip(segmentId)
      : this.publisher.removeQueuedSegment(segmentId);
    if (!removed) {
      return false;
    }
    this.runtime.removeQueuedSegment(segmentId, this.getPlannedBufferedSec());
    return true;
  }

  updateQueuedSegment(segmentId: string, patch: { priority?: number; pinned?: boolean }): boolean {
    const updated = this.useAudioEngine
      ? Boolean(this.runtime.updateQueuedSegment(segmentId, patch, this.getPlannedBufferedSec()))
      : this.publisher.updateQueuedSegment(segmentId, patch);
    if (!updated) {
      return false;
    }
    if (!this.useAudioEngine) {
      this.runtime.updateQueuedSegment(segmentId, patch, this.publisher.getBufferedSec());
    }
    return true;
  }

  getTimelineSnapshot(): TimelineSnapshot {
    const s = this.runtime.snapshot();
    return buildTimelineSnapshot(s);
  }

  rebuildTimeline(reason = "manual"): TimelineSnapshot {
    this.runtime.markSchedulerRebuild("started", reason);
    try {
      const snap = this.getTimelineSnapshot();
      this.runtime.markSchedulerRebuild("done", reason);
      return snap;
    } catch (error) {
      this.runtime.markSchedulerRebuild("failed", reason);
      throw error;
    }
  }

  skipCurrentSegment(): boolean {
    this.runtime.markSkipRequested();
    if (this.useAudioEngine) {
      return false;
    }
    const ok = this.publisher.skipCurrentSegment();
    if (ok) {
      this.runtime.markSkipCompleted();
    }
    return ok;
  }

  getMediaPath(segmentId: string): string | null {
    return this.runtime.getMediaPath(segmentId);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(appConfig.workDir, { recursive: true });
    this.tracks = await loadCatalog(appConfig.catalogPath);
    this.resetShuffleOrder();
    this.stationIdAvailable = await this.checkStationId();
    this.stationIdDurationSec = this.stationIdAvailable ? await this.safeStationIdDuration() : 0;
    await this.yt.init();
    this.scheduleCursorSec = 0;
    this.lastScheduledSegment = null;

    if (this.useAudioEngine) {
      await this.audioEngine.start();
      this.scheduleCursorSec = this.audioEngine.nowSec();
    } else {
      await this.publisher.start();
    }

    this.running = true;
    this.songsSinceCommentary = 0;
    this.lastMeterPushMs = 0;
    this.runtime.setCore({
      running: true,
      phase: this.phase,
      tracksLoaded: this.tracks.length,
      bufferedSec: this.getPlannedBufferedSec(),
      lastError: null
    });
    this.runtime.setMeters(this.useAudioEngine ? this.audioEngine.getMeters() : {
      music: 0,
      voice: 0,
      jingle: 0,
      ads: 0,
      master: 0
    });
    this.loop().catch((err) => {
      this.lastError = String(err instanceof Error ? err.message : err);
      logError("orchestrator.loop.crash", err);
      this.running = false;
      this.runtime.markBuildFailed(this.lastError);
      this.runtime.setCore({ running: false, lastError: this.lastError });
    });
    log("orchestrator.started", { tracks: this.tracks.length, mode: this.useAudioEngine ? "audio-engine" : "publisher" });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.useAudioEngine) {
      await this.audioEngine.stop();
    } else {
      await this.publisher.stop();
    }
    this.runtime.setMeters({
      music: 0,
      voice: 0,
      jingle: 0,
      ads: 0,
      master: 0
    });
    this.runtime.setCore({ running: false, bufferedSec: this.getPlannedBufferedSec() });
    log("orchestrator.stopped");
  }

  status(): Record<string, unknown> {
    const s = this.runtime.snapshot();
    return { running: s.running, tracksLoaded: s.tracksLoaded, phase: s.phase, bufferedSec: s.bufferedSec, lastPlayed: this.lastPlayed.map((t) => `${t.title} - ${t.artist}`), lastError: s.lastError };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.useAudioEngine) {
        this.audioEngine.syncLifecycle();
        this.maybePublishMeters();
        this.audioEngine.renderAndPushUntil(4).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          this.lastError = msg;
          this.runtime.setCore({ lastError: msg });
          this.runtime.markBuildFailed(msg);
          logError("audioengine.render.loop", error);
        });
      }

      let bufferedSec = this.getPlannedBufferedSec();
      this.runtime.setCore({ bufferedSec, phase: this.phase });

      let builds = 0;
      const maxBuildsPerTick = this.useAudioEngine ? 4 : 1;
      while (bufferedSec < appConfig.targetBufferSec && builds < maxBuildsPerTick) {
        try {
          this.runtime.markBuildStarted(this.phase);
          const seg = await this.buildNextSegment();
          await this.enqueueSegmentForOutput(seg);
          log("segment.enqueued", {
            segmentId: seg.id,
            type: seg.type,
            durationSec: seg.durationSec,
            bufferedSec: this.getPlannedBufferedSec(),
            notes: seg.notes
          });
          builds += 1;
          bufferedSec = this.getPlannedBufferedSec();
          this.runtime.setCore({ bufferedSec, phase: this.phase });
        } catch (error) {
          this.lastError = String(error instanceof Error ? error.message : error);
          logError("segment.build.error", error);
          this.runtime.markBuildFailed(this.lastError);
          this.runtime.setCore({ lastError: this.lastError });
          await this.enqueueEmergencySilence();
          break;
        }
      }
      await wait(250);
    }
  }

  private maybePublishMeters(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastMeterPushMs < 300) {
      return;
    }
    this.lastMeterPushMs = nowMs;
    this.runtime.setMeters(this.audioEngine.getMeters());
  }

  private async enqueueSegmentForOutput(seg: RenderedSegment): Promise<void> {
    if (!this.useAudioEngine) {
      this.publisher.enqueue(seg);
      this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
      return;
    }

    const channel = this.mapSegmentChannel(seg.type);
    const baseStartSec = Math.max(this.scheduleCursorSec, this.audioEngine.nowSec());
    let startAtSec = baseStartSec;

    if (seg.type === "songs" && this.lastScheduledSegment?.type === "commentary") {
      const overlapStart = this.lastScheduledSegment.startAtSec + (this.lastScheduledSegment.durationSec * 0.5);
      startAtSec = Math.max(this.audioEngine.nowSec(), Math.min(baseStartSec, overlapStart));
    }

    if (seg.type === "commentary" && this.stationIdAvailable && this.stationIdDurationSec > 0.05) {
      const crossfadeSec = Math.min(0.45, this.stationIdDurationSec * 0.4);
      const voiceStartSec = baseStartSec + Math.max(0, this.stationIdDurationSec - crossfadeSec);
      this.audioEngine.addClip({
        id: `${seg.id}::station-id`,
        channel: "jingle",
        filePath: appConfig.stationIdPath,
        startAtSec: baseStartSec,
        durationSec: this.stationIdDurationSec,
        gain: 1,
        gainFrom: 1,
        gainTo: 0.15,
        gainRampSec: Math.max(0.2, this.stationIdDurationSec)
      });
      startAtSec = voiceStartSec;
    }

    seg.channel = channel;
    seg.scheduledStartSec = startAtSec;

    this.audioEngine.addClip({
      id: seg.id,
      segmentId: seg.id,
      channel,
      filePath: seg.filePath,
      startAtSec,
      durationSec: seg.durationSec,
      gain: channel === "voice" ? 1.35 : 1,
      gainFrom: channel === "voice" ? 0.65 : 0.7,
      gainTo: channel === "voice" ? 1.35 : 1,
      gainRampSec: channel === "voice" ? 3.5 : 7
    });

    this.scheduleCursorSec = Math.max(this.scheduleCursorSec, startAtSec + seg.durationSec);
    this.lastScheduledSegment = { type: seg.type, startAtSec, durationSec: seg.durationSec };
    this.runtime.enqueueSegment(seg, this.getPlannedBufferedSec());
  }

  private mapSegmentChannel(type: RenderedSegment["type"]): AudioChannel {
    if (type === "commentary") return "voice";
    if (type === "liner") return "jingle";
    return "music";
  }

  private getPlannedBufferedSec(): number {
    if (!this.useAudioEngine) return this.publisher.getBufferedSec();
    const now = this.audioEngine.nowSec();
    const scheduled = Math.max(0, this.scheduleCursorSec - now);
    return Math.max(scheduled, this.audioEngine.bufferedSec());
  }

  private nextTrack(): Track {
    if (!this.tracks.length) {
      throw new Error("No tracks available");
    }
    if (!this.shuffledTrackOrder.length || this.shuffledPtr >= this.shuffledTrackOrder.length) {
      this.resetShuffleOrder();
    }
    const idx = this.shuffledTrackOrder[this.shuffledPtr];
    this.shuffledPtr += 1;
    return this.tracks[idx] as Track;
  }

  private resetShuffleOrder(): void {
    const n = this.tracks.length;
    this.shuffledTrackOrder = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = this.shuffledTrackOrder[i];
      const b = this.shuffledTrackOrder[j];
      this.shuffledTrackOrder[i] = b;
      this.shuffledTrackOrder[j] = a;
    }

    if (n > 1 && this.lastPlayed[0]) {
      const lastId = this.lastPlayed[0].id;
      const firstIdx = this.shuffledTrackOrder[0];
      const firstTrack = this.tracks[firstIdx];
      if (firstTrack?.id === lastId) {
        const swapIdx = 1 + Math.floor(Math.random() * (n - 1));
        const tmp = this.shuffledTrackOrder[0];
        this.shuffledTrackOrder[0] = this.shuffledTrackOrder[swapIdx];
        this.shuffledTrackOrder[swapIdx] = tmp;
      }
    }
    this.shuffledPtr = 0;
  }

  private async buildNextSegment(): Promise<RenderedSegment> {
    if (this.phase === "songs") {
      const track = this.nextTrack();
      let out: string;
      try {
        const rawSong = await this.yt.fetchTrackWav(track);
        out = makeOutFile(appConfig.workDir, "song-faded");
        await applyEdgeFades(rawSong, out, 0.4, 0.9);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.runtime.markYoutubeError(msg);
        throw error;
      }

      const durationSec = await getDurationSec(out);
      this.lastPlayed = [track];
      this.songsSinceCommentary += 1;
      const cadence = Math.max(1, appConfig.commentaryEveryNSongs);
      this.phase = this.songsSinceCommentary >= cadence ? "commentary" : "songs";
      this.runtime.setCore({ phase: this.phase });

      return {
        id: `songs-${Date.now()}`,
        type: "songs",
        filePath: out,
        durationSec,
        notes: `${track.title} - ${track.artist}`,
        source: "auto",
        priority: 50,
        pinned: false
      };
    }

    const next = this.peekNextTrack();
    let out = makeOutFile(appConfig.workDir, "talk");
    let type: RenderedSegment["type"] = "commentary";
    let notes = "generated commentary";
    let commentaryText: string | undefined;

    try {
      const text = await this.commentary.generateCommentary(this.lastPlayed, next);
      commentaryText = text;
      notes = text;
      this.runtime.markCommentaryGenerated(text.length);
      try {
        const raw = makeOutFile(appConfig.workDir, "talk-raw");
        out = await this.tts.synthToFile(text, raw);
        const voiced = makeOutFile(appConfig.workDir, "talk-mix");
        await enhanceCommentaryVoice(out, voiced);
        let withStationId = voiced;
        if (this.stationIdAvailable && !this.useAudioEngine) {
          const pre = makeOutFile(appConfig.workDir, "talk-with-id");
          await prependStationId(appConfig.stationIdPath, voiced, pre);
          withStationId = pre;
        }
        const finalOut = makeOutFile(appConfig.workDir, "talk-faded");
        await applyEdgeFades(withStationId, finalOut, 0.25, 0);
        out = finalOut;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.runtime.markTtsError(message);
        throw error;
      }
    } catch (error) {
      logError("commentary.failed", error);
      const message = error instanceof Error ? error.message : String(error);
      this.runtime.markCommentaryFallback(message);
      const liner = await this.pickEmergencyLiner();
      if (liner) {
        out = liner;
        type = "liner";
        notes = "emergency liner fallback";
      } else {
        await silenceFile(out, 3);
        type = "liner";
        notes = "silence fallback";
      }
    }

    const durationSec = await getDurationSec(out);
    this.phase = "songs";
    this.songsSinceCommentary = 0;
    this.runtime.setCore({ phase: this.phase });

    return {
      id: `talk-${Date.now()}`,
      type,
      filePath: out,
      durationSec,
      notes,
      commentaryText,
      source: "auto",
      priority: 50,
      pinned: false
    };
  }

  private async pickEmergencyLiner(): Promise<string | null> {
    try {
      const entries = await readdir(appConfig.emergencyDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".wav"))
        .map((e) => path.join(appConfig.emergencyDir, e.name));
      if (!files.length) return null;
      return files[Math.floor(Math.random() * files.length)];
    } catch {
      return null;
    }
  }

  private peekNextTrack(): Track | null {
    if (!this.tracks.length) return null;
    if (!this.shuffledTrackOrder.length || this.shuffledPtr >= this.shuffledTrackOrder.length) {
      this.resetShuffleOrder();
    }
    const idx = this.shuffledTrackOrder[this.shuffledPtr];
    return this.tracks[idx] || null;
  }

  private async checkStationId(): Promise<boolean> {
    try {
      await access(appConfig.stationIdPath);
      return true;
    } catch {
      return false;
    }
  }

  private async safeStationIdDuration(): Promise<number> {
    try {
      return await getDurationSec(appConfig.stationIdPath);
    } catch {
      return 0;
    }
  }

  private async enqueueEmergencySilence(): Promise<void> {
    const out = makeOutFile(appConfig.workDir, "recover");
    await silenceFile(out, 2);
    const durationSec = await getDurationSec(out);
    const seg: RenderedSegment = {
      id: `recover-${Date.now()}`,
      type: "liner",
      filePath: out,
      durationSec,
      notes: "recovery silence",
      source: "auto",
      priority: 200,
      pinned: true
    };
    await this.enqueueSegmentForOutput(seg);
  }
}
