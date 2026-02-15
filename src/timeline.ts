import { execCmd } from "./proc";

export type TimelineClip = {
  filePath: string;
  startSec: number;
  sourceOffsetSec?: number;
  durationSec?: number;
  gain?: number;
  gainStart?: number;
  gainEnd?: number;
  gainRampSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

export async function renderTimeline(
  clips: TimelineClip[],
  outFile: string,
  opts?: { master?: boolean }
): Promise<void> {
  if (!clips.length) {
    throw new Error("renderTimeline requires at least one clip");
  }

  const args: string[] = ["-y"];
  for (const c of clips) {
    args.push("-i", c.filePath);
  }

  const lines: string[] = [];
  const delayedLabels: string[] = [];

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const inLabel = `[${i}:a]`;
    const sourceOffsetSec = Math.max(0, clip.sourceOffsetSec || 0);
    const trim = clip.durationSec && clip.durationSec > 0
      ? `atrim=start=${sourceOffsetSec.toFixed(3)}:end=${(sourceOffsetSec + clip.durationSec).toFixed(3)},`
      : sourceOffsetSec > 0
        ? `atrim=start=${sourceOffsetSec.toFixed(3)},`
        : "";
    const gain = clip.gain ?? 1;
    const gainStart = clip.gainStart ?? gain;
    const gainEnd = clip.gainEnd ?? gain;
    const gainRampSec = Math.max(0.02, clip.gainRampSec || clip.durationSec || 0.02);
    const gainExpr = Math.abs(gainEnd - gainStart) < 0.0001 || !clip.durationSec || clip.durationSec <= 0.02
      ? `${gainStart}`
      : `${gainStart.toFixed(6)}+(${(gainEnd - gainStart).toFixed(6)})*(t/${gainRampSec.toFixed(6)})`;
    const volumeFilter = Math.abs(gainEnd - gainStart) < 0.0001 || !clip.durationSec || clip.durationSec <= 0.02
      ? `volume=${gainExpr}`
      : `volume=${gainExpr}:eval=frame`;
    const fadeIn = clip.fadeInSec && clip.fadeInSec > 0 ? `,afade=t=in:st=0:d=${clip.fadeInSec}` : "";
    const fadeOut = clip.fadeOutSec && clip.fadeOutSec > 0 && clip.durationSec && clip.durationSec > clip.fadeOutSec
      ? `,afade=t=out:st=${(clip.durationSec - clip.fadeOutSec).toFixed(3)}:d=${clip.fadeOutSec}`
      : "";
    const pre = `c${i}`;
    lines.push(`${inLabel}${trim}asetpts=PTS-STARTPTS,${volumeFilter}${fadeIn}${fadeOut}[${pre}]`);

    const delayMs = Math.max(0, Math.floor((clip.startSec || 0) * 1000));
    const out = `d${i}`;
    lines.push(`[${pre}]adelay=${delayMs}|${delayMs}[${out}]`);
    delayedLabels.push(`[${out}]`);
  }

  const mixedLabel = "mix0";
  lines.push(`${delayedLabels.join("")}amix=inputs=${clips.length}:duration=longest:normalize=0[${mixedLabel}]`);

  const outLabel = "out";
  if (opts?.master !== false) {
    lines.push(
      `[${mixedLabel}]loudnorm=I=-14:TP=-1.2:LRA=7,acompressor=threshold=-18dB:ratio=2.4:attack=20:release=180,alimiter=limit=0.89[${outLabel}]`
    );
  } else {
    lines.push(`[${mixedLabel}]anull[${outLabel}]`);
  }

  args.push(
    "-filter_complex",
    lines.join(";"),
    "-map",
    `[${outLabel}]`,
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  );

  await execCmd("ffmpeg", args);
}
