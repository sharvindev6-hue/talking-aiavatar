import { parseAssistantJson } from "./parse.js";

/**
 * Streaming chat client.
 *
 * Sends { stream: true } to /api/chat and reads Server-Sent Events back:
 *   event: start  -> { sessionId }
 *   event: delta  -> { delta, full }   (partial text so far)
 *   event: reset  -> { reason }        (retry/tool round: clear partial text)
 *   event: done   -> { content, parsed }
 *   event: error  -> { error }
 *
 * If the server replies with plain JSON (validation error, or a fallback
 * deployment), the JSON path is used instead — so streaming never breaks
 * chat.
 */
export class ChatClient {
  constructor() {
    this._controller = null;
  }

  /** Abort an in-flight stream (Stop button / new message / logout). */
  stop() {
    this._controller?.abort();
    this._controller = null;
  }

  /**
   * Send a message. Resolves with the structured reply.
   * @param {string} sessionId
   * @param {string} message
   * @param {Array} [attachments]
   * @param {{ onToken?: (delta: string, full: string) => void,
   *           onComplete?: (parsed: object, content: string) => void,
   *           onError?: (err: Error) => void }} [hooks]
   */
  async sendMessage(sessionId, message, attachments = [], hooks = {}) {
    const { onToken, onComplete, onError } = hooks;
    this._controller = new AbortController();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message, attachments, stream: true }),
        signal: this._controller.signal,
      });

      if (!response.ok) {
        // Validation/auth errors come back as plain JSON (SSE headers are
        // only written right before the model call).
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Chat failed (${response.status})`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        // Fallback: the deployment returned a JSON body (non-stream mode).
        const data = await response.json();
        const content = data.content || "";
        const structured = data.parsed || parseAssistantJson(content);
        if (content) onToken?.(content, content);
        onComplete?.(structured, content);
        return structured;
      }

      const structured = await this._readStream(response.body, hooks);
      this._controller = null;
      return structured;
    } catch (err) {
      this._controller = null;
      if (err.name === "AbortError") {
        onError?.(new Error("Stopped"));
        return null;
      }
      onError?.(err);
      throw err;
    }
  }

  /** Consume the SSE body, dispatching events. Returns the final parsed reply. */
  async _readStream(body, { onToken, onComplete, onError } = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let content = "";
    let structured = null;
    let streamError = null;

    const dispatch = (event, data) => {
      let j = null;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (event === "delta") {
        full = j.full ?? full + (j.delta || "");
        onToken?.(j.delta || "", full);
      } else if (event === "reset") {
        full = "";
        onToken?.("", full);
      } else if (event === "done") {
        content = j.content || full;
        structured = j.parsed || parseAssistantJson(content);
      } else if (event === "error") {
        streamError = new Error(j.error || "Chat failed");
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line; parse complete ones.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          const dataLines = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length > 0) dispatch(event, dataLines.join("\n"));
          if (streamError) throw streamError;
        }
      }
      // Tail: a final event without trailing blank line.
      if (buffer.trim()) {
        let event = "message";
        const dataLines = [];
        for (const line of buffer.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) dispatch(event, dataLines.join("\n"));
      }
    } finally {
      reader.releaseLock?.();
    }

    if (streamError) throw streamError;
    if (!structured) structured = parseAssistantJson(content || full);
    onComplete?.(structured, content || full);
    return structured;
  }
}
