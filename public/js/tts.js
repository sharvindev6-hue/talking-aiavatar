const PCM_SAMPLE_RATE = 22050;

export class ElevenLabsTTS {
  constructor() {
    this.abortController = null;
  }

  async speak(text, { onAudioChunk, onWords, onStart, onEnd, onError } = {}) {
    this.stop();
    this.abortController = new AbortController();

    let audioOffsetMs = 0;
    const allWords = [];
    const allTimes = [];
    const allDurations = [];

    try {
      onStart?.();

      const res = await fetch("/api/tts/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(parseApiError(err.error) || `TTS failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }

          if (chunk.audio_base64) {
            onAudioChunk?.(base64ToArrayBuffer(chunk.audio_base64));
          }

          const alignment = chunk.alignment || chunk.normalized_alignment;
          if (alignment && onWords) {
            const { words, times, durations } = alignmentToWords(
              normalizeAlignment(alignment),
              audioOffsetMs
            );
            for (let i = 0; i < words.length; i++) {
              allWords.push(words[i]);
              allTimes.push(times[i]);
              allDurations.push(durations[i]);
            }
            onWords(allWords, allTimes, allDurations);
            const chunkEnd =
              times.length > 0
                ? times[times.length - 1] + durations[durations.length - 1]
                : 0;
            audioOffsetMs = Math.max(audioOffsetMs, chunkEnd);
          }
        }
      }

      onEnd?.();
    } catch (err) {
      if (err.name !== "AbortError") {
        onError?.(err);
        throw err;
      }
    }
  }

  stop() {
    this.abortController?.abort();
    this.abortController = null;
  }
}

function parseApiError(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.detail?.message || raw;
    } catch {
      return raw.slice(0, 200);
    }
  }
  return String(raw);
}

function normalizeAlignment(alignment) {
  if (alignment.chars) return alignment;
  return {
    chars: alignment.characters || [],
    charStartTimesMs: (alignment.character_start_times_seconds || []).map(
      (s) => Math.round(s * 1000)
    ),
    charDurationsMs: (alignment.character_end_times_seconds || []).map((end, i) => {
      const start = alignment.character_start_times_seconds?.[i] || 0;
      return Math.round((end - start) * 1000);
    }),
  };
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function alignmentToWords(alignment, offsetMs) {
  const chars = alignment.chars || [];
  const starts = alignment.charStartTimesMs || [];
  const durations = alignment.charDurationsMs || [];

  const words = [];
  const times = [];
  const durs = [];

  let current = "";
  let wordStart = null;
  let wordDur = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isSpace = ch === " " || ch === "\n";

    if (!isSpace && current === "") {
      wordStart = (starts[i] || 0) + offsetMs;
      wordDur = durations[i] || 0;
      current = ch;
    } else if (!isSpace) {
      wordDur += durations[i] || 0;
      current += ch;
    } else if (current) {
      words.push(current);
      times.push(wordStart);
      durs.push(wordDur);
      current = "";
      wordStart = null;
      wordDur = 0;
    }
  }

  if (current) {
    words.push(current);
    times.push(wordStart ?? offsetMs);
    durs.push(wordDur || 80);
  }

  return { words, times, durations: durs };
}

export { PCM_SAMPLE_RATE };
