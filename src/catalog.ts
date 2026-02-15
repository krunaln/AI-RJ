import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Track } from "./types";

const trackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  youtube_url: z.string().url(),
  duration_sec: z.number().int().positive(),
  tags: z.array(z.string()).default([]),
  energy: z.number().min(0).max(1).default(0.5),
  mood: z.string().default("neutral"),
  language: z.string().default("en")
});

const catalogSchema = z.array(trackSchema).min(1);

export async function loadCatalog(filePath: string): Promise<Track[]> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  const tracks = catalogSchema.parse(parsed);
  return tracks;
}
