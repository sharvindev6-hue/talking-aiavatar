import WebSocket, { WebSocketServer } from "ws";
import { query } from "./db.js";
import { hashToken, SESSION_COOKIE } from "./auth.js";

// Only streaming TTS paths may be proxied — anything else (account, voice
// settings, user endpoints) is refused so the key can't be used arbitrarily.
const ALLOWED_PREFIXES = ["/v1/text-to-speech/"];

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

export function setupElevenLabsProxy(server) {
  const wss = new WebSocketServer({ noServer: true });
  const apiKey = process.env.ELEVENLABS_API_KEY;

  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (!url.pathname.startsWith("/elevenlabs/")) {
        socket.destroy();
        return;
      }

      // Path whitelist — only the streaming TTS endpoint is proxied.
      const targetPath = url.pathname.replace("/elevenlabs", "");
      if (!ALLOWED_PREFIXES.some((p) => targetPath.startsWith(p))) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      // Require a valid session (same cookie auth as the REST API).
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (!apiKey || !token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const { rows } = await query(
        "SELECT 1 FROM sessions WHERE token = $1 AND expires_at > now()",
        [hashToken(token)]
      );
      if (!rows[0]) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (clientWs) => {
        const targetUrl = `wss://api.elevenlabs.io${targetPath}${url.search}`;

        const upstream = new WebSocket(targetUrl, {
          headers: { "xi-api-key": apiKey },
        });

        const closeBoth = (code, reason) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
          if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
        };

        upstream.on("open", () => {
          clientWs.on("message", (data) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
          });

          upstream.on("message", (data) => {
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
          });
        });

        upstream.on("error", (err) => {
          console.error("ElevenLabs upstream error:", err.message);
          closeBoth(1011, "upstream error");
        });

        clientWs.on("error", (err) => {
          console.error("ElevenLabs client error:", err.message);
          closeBoth(1011, "client error");
        });

        upstream.on("close", () => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        });

        clientWs.on("close", () => {
          if (upstream.readyState === WebSocket.OPEN) upstream.close();
        });
      });
    } catch (err) {
      console.error("WebSocket upgrade error:", err.message);
      socket.destroy();
    }
  });
}
