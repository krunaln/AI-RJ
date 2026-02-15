import type { Track } from "./types";
import { appConfig } from "./config";

/* ----------------------------- Style Pools ----------------------------- */

const styles = [
  "energetic late-night host with playful punchlines",
  "cinematic storytelling host with dramatic pacing",
  "high-voltage hype host amplifying energy shifts",
  "cool conversational host with sharp cultural references"
];

const formats = [
  "rapid-fire short bursts",
  "cinematic build-up into sharp punchline",
  "conversational with a mid-line interruption",
  "crescendo that explodes into transition",
  "whisper-to-hype escalation"
];

const hooks = [
  "Ask a playful rhetorical question.",
  "Drop a subtle cultural reference.",
  "Tease the next track mysteriously.",
  "React dramatically to the previous song.",
  "Build anticipation like a countdown."
];

const quirks = [
  "Stretch one word dramatically.",
  "Use one unexpected metaphor.",
  "Add one playful exaggeration.",
  "Include a spontaneous laugh-like expression (ha, ohhh, whoa).",
  "Break sentence rhythm intentionally once."
];

const timeOfDayModes = [
  "late-night electric city vibe",
  "early morning drive-time momentum",
  "midday smooth flow",
  "weekend party ignition mode",
  "sunset wind-down mood"
];

const listenerOpeners = [
  "Hey night riders,",
  "Alright beautiful people,",
  "What’s up city pulse,",
  "Good vibes crew,",
  "Dialed in legends,"
];

const ctas = [
  "Turn it up.",
  "Lean into it.",
  "Stay locked right here.",
  "Let it move you.",
  "Don’t blink."
];

/* ----------------------------- Utilities ----------------------------- */

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chance(probability: number): boolean {
  return Math.random() < probability;
}

function inferGenreContext(track?: Track | null): string {
  if (!track) return "mixed genre vibes";

  const mood = track.mood?.toLowerCase() || "";
  const energy = track.energy ?? 5;

  if (energy >= 8) return "high-energy anthem intensity";
  if (mood.includes("chill")) return "smooth laid-back flow";
  if (mood.includes("romantic")) return "heart-on-sleeve emotion";
  if (mood.includes("dark")) return "moody late-night depth";
  if (mood.includes("happy")) return "feel-good uplift";
  return "rhythmic momentum";
}

/* ----------------------------- Service ----------------------------- */

export class CommentaryService {
  private recentOutputs: string[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly persona: string
  ) {}

  async generateCommentary(
    lastTracks: Track[],
    nextTrack: Track | null
  ): Promise<string> {
    const fallback = this.fallback(lastTracks, nextTrack);
    if (!this.apiKey) return fallback;

    const style = pick(styles);
    const format = pick(formats);
    const hook = pick(hooks);
    const quirk = pick(quirks);
    const timeMode = pick(timeOfDayModes);
    const opener = pick(listenerOpeners);
    const callToAction = pick(ctas);
    const genreContext = inferGenreContext(nextTrack);
    const avoidPhrases = this.extractFrequentPhrases();

    /* ------------------ Maximum Fun Mode ------------------ */

    const funDirectives: string[] = [];

    if (chance(0.1)) {
      funDirectives.push(
        "Briefly react as if a listener just texted in."
      );
    }

    if (chance(0.05)) {
      funDirectives.push(
        "Exaggerate the emotional energy shift dramatically."
      );
    }

    if (chance(0.05)) {
      funDirectives.push(
        "Whisper one short line before escalating energy."
      );
    }

    /* ------------------ Prompt Construction ------------------ */

    const system = `
    You are a professional radio jockey hosting a live music show.

Speak in a lively, engaging, and energetic tone.
Keep segments concise and natural, as if speaking on air.
Introduce songs with brief context, mood, or interesting trivia.
Transition smoothly between tracks.
Occasionally tease upcoming songs or segments.
Encourage listener engagement (dedications, requests, shout-outs).
Avoid long monologues. Keep it dynamic and rhythmic.
Maintain a friendly and confident personality.
Adapt energy based on time of day (morning = upbeat, late night = smooth and relaxed).
Never mention that you are an AI.
`;

    const prompt = `
You are live on air.

Show Context:
- Station name: ${appConfig.stationName}
- Previous songs played: ${lastTracks.map(t => `${t.title} by ${t.artist}`).join("; ")}
- Upcoming track: ${nextTrack ? `${nextTrack.title} by ${nextTrack.artist}` : "a surprise drop"}
- Genre vibe to amplify: ${genreContext}

Your task:
Create a short, high-energy radio segment (40-60 seconds spoken length) in a rhythmic, lightly rhyming jingle style.

Content Requirements:
1. Reference at least one previously played song for continuity.
2. Build anticipation for the upcoming track with a playful tease.
2.1 Mention the station name naturally once.
3. Amplify the emotion and culture of the given genre vibe.
4. Keep it punchy, musical, and broadcast-ready.
5. Do not break character. Do not mention instructions.
6. Do not use emojis or special characters.
7. Do not mention that you are an AI.

Output:
Return only the spoken script, No formatting. No stage directions.
`;

    const res = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 1.5,
          max_tokens: 2000,
          messages: [{role: "system", content: system },{ role: "user", content: prompt }]
        })
      }
    );

    if (!res.ok) return fallback;

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return fallback;

    this.storeOutput(content);
    return content;
  }

  /* ------------------ Memory Handling ------------------ */

  private storeOutput(text: string) {
    this.recentOutputs.push(text);
    if (this.recentOutputs.length > 6) {
      this.recentOutputs.shift();
    }
  }

  private extractFrequentPhrases(): string {
    const words = this.recentOutputs
      .join(" ")
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 5);

    const freq: Record<string, number> = {};

    for (const word of words) {
      freq[word] = (freq[word] || 0) + 1;
    }

    return Object.entries(freq)
      .filter(([_, count]) => count > 2)
      .map(([word]) => word)
      .slice(0, 6)
      .join(", ");
  }

  /* ------------------ Fallback ------------------ */

  private fallback(lastTracks: Track[], nextTrack: Track | null): string {
    const prev = lastTracks[lastTracks.length - 1];
    const prevTxt = prev
      ? `${prev.title} by ${prev.artist}`
      : "that last track";

    const nextTxt = nextTrack
      ? `${nextTrack.title} by ${nextTrack.artist}`
      : "our next song";

    return `That was ${prevTxt}. Now we roll into ${nextTxt}. You are listening to ${appConfig.stationName}.`;
  }
}
