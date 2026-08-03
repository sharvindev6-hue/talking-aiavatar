import { parseAssistantJson } from "./parse.js";

export class ChatClient {
  /**
   * @param {string} sessionId - active chat session (created via /api/history)
   * @param {string} message - the new user message
   * @param {Array} [attachments] - [{ name, type, size, dataUrl }]
   */
  async sendMessage(sessionId, message, attachments = [], { onToken, onComplete, onError } = {}) {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message, attachments }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Chat failed (${response.status})`);
      }

      const data = await response.json();
      const content = data.content || "";
      const structured = data.parsed || parseAssistantJson(content);

      if (content) {
        onToken?.(content, content);
      }

      onComplete?.(structured, content);
      return structured;
    } catch (err) {
      onError?.(err);
      throw err;
    }
  }
}
