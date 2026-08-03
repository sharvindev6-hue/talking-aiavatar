export function parseAssistantJson(raw) {
  let trimmed = (raw || "").trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // The model sometimes emits one JSON object PER ANSWER, concatenated
  // (e.g. {"say":"1. ..."} {"say":"2. ..."}). When we see more than one
  // "say" key, join all of their values into a single complete reply.
  const anchoredSays = [
    ...trimmed.matchAll(/"say"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:emotion|gesture)"/g),
  ].map((m) => m[1].replace(/\\"/g, '"'));
  const plainSays = [
    ...trimmed.matchAll(/"say"\s*:\s*"((?:[^"\\]|\\.)*?)"/g),
  ].map((m) => m[1].replace(/\\"/g, '"'));
  const says = anchoredSays.length >= 2 ? anchoredSays : plainSays;
  // Only join when there are actually 2+ JSON objects (2+ "{" braces) —
  // otherwise a single reply that merely quotes "say" text would be falsely
  // joined into fragments. The model may interleave question text between
  // objects, so brace counting (not a "}{" boundary) is the safe signal.
  if (says.length >= 2 && (trimmed.match(/\{/g) || []).length >= 2) {
    const emotions = [...trimmed.matchAll(/"emotion"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    const gestures = [...trimmed.matchAll(/"gesture"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    return {
      say: says.join("\n\n").slice(0, 8000),
      emotion: emotions.length ? emotions[emotions.length - 1] : "neutral",
      gesture: gestures.length ? gestures[gestures.length - 1] : "none",
    };
  }

  // 1. Try the outermost JSON object (greedy: match the LAST closing brace,
  //    so nested braces or braces inside strings don't truncate the parse).
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    // Models sometimes emit literal newlines inside string values, which is
    // invalid JSON — repair them within quoted strings before parsing.
    const repaired = jsonMatch[0].replace(/"((?:[^"\\]|\\.)*?)"/g, (m) =>
      m.replace(/\r?\n/g, "\\n")
    );
    try {
      const parsed = JSON.parse(repaired);
      return {
        say: parsed.say || trimmed,
        emotion: parsed.emotion || "neutral",
        gesture: parsed.gesture || "none",
      };
    } catch {
      /* fall through */
    }
  }

  // 2. Repair truncated/malformed JSON: pull out the "say" value directly.
  //    Anchor on the following "emotion"/"gesture" key (the prompt always
  //    emits them) so embedded literal quotes inside the reply don't
  //    truncate it. No length cap here — replies can be long lists.
  const sayMatch =
    trimmed.match(/"say"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:emotion|gesture)"/) ||
    trimmed.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (sayMatch) {
    return {
      say: sayMatch[1].replace(/\\"/g, '"').slice(0, 8000),
      emotion: "neutral",
      gesture: "none",
    };
  }

  // 3. First quoted phrase — long enough to never match a bare JSON key
  //    like "say" (which caused replies of just the word "say").
  const quoted = trimmed.match(/"((?:[^"\\]|\\.){8,300})"/);
  if (quoted) {
    return {
      say: quoted[1].replace(/\\"/g, '"'),
      emotion: "happy",
      gesture: "none",
    };
  }

  return { say: trimmed, emotion: "neutral", gesture: "none" };
}
