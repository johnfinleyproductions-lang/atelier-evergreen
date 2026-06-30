// lib/whisper-client.ts
//
// Atelier voice I/O. transcribe() posts audio to the Whisper STT service on
// vidbox (faster-whisper, GPU); speak() posts text to VoxStation TTS. Both are
// LAN/tailnet services reached server-side from API routes. Graceful errors —
// never throw; return a typed result the caller can branch on.

const STT_URL = process.env.ATELIER_STT_URL ?? 'http://192.168.4.196:8025/stt';
// VoxStation TTS — exact synth path is host-specific; override via env.
// TODO(voice): confirm the VoxStation synth endpoint path on :8020.
const TTS_URL = process.env.ATELIER_TTS_URL ?? 'http://192.168.4.196:8020/api/tts';

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  ok: boolean;
  text: string;
  words: TranscriptWord[];
  durationS: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface SpeakResult {
  ok: boolean;
  audioUrl: string | null;
  audioBase64: string | null;
  error: string | null;
}

/** POST audio bytes to the Whisper STT service. Returns text + word timings. */
export async function transcribe(
  audio: Buffer | Uint8Array | Blob,
  opts: { filename?: string; wordTimestamps?: boolean } = {},
): Promise<TranscribeResult> {
  try {
    const form = new FormData();
    const blob =
      audio instanceof Blob
        ? audio
        : new Blob([audio as Uint8Array], { type: 'audio/wav' });
    form.append('audio', blob, opts.filename ?? 'capture.wav');
    form.append('word_timestamps', String(opts.wordTimestamps ?? true));

    const res = await fetch(STT_URL, { method: 'POST', body: form });
    if (!res.ok) {
      return { ok: false, text: '', words: [], durationS: null, latencyMs: null, error: `STT_HTTP_${res.status}` };
    }
    const j = (await res.json()) as {
      text?: string;
      words?: TranscriptWord[];
      duration_s?: number;
      latency_ms?: number;
    };
    return {
      ok: true,
      text: (j.text ?? '').trim(),
      words: Array.isArray(j.words) ? j.words : [],
      durationS: j.duration_s ?? null,
      latencyMs: j.latency_ms ?? null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      words: [],
      durationS: null,
      latencyMs: null,
      error: err instanceof Error ? err.message : 'STT_UNREACHABLE',
    };
  }
}

/** POST text to VoxStation TTS. Returns an audio URL or base64 (best effort). */
export async function speak(
  text: string,
  opts: { voiceId?: string } = {},
): Promise<SpeakResult> {
  try {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice_id: opts.voiceId ?? null }),
    });
    if (!res.ok) {
      return { ok: false, audioUrl: null, audioBase64: null, error: `TTS_HTTP_${res.status}` };
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const j = (await res.json()) as { audioUrl?: string; url?: string; audio_base64?: string };
      return { ok: true, audioUrl: j.audioUrl ?? j.url ?? null, audioBase64: j.audio_base64 ?? null, error: null };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, audioUrl: null, audioBase64: buf.toString('base64'), error: null };
  } catch (err) {
    return {
      ok: false,
      audioUrl: null,
      audioBase64: null,
      error: err instanceof Error ? err.message : 'TTS_UNREACHABLE',
    };
  }
}
