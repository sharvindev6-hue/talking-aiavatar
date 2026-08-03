// Agent tools: always-on context (time) and a web search helper used by the
// JSON tool-loop in the chat route.
//
// Web search deliberately uses a keyless, dependency-free source (Wikipedia
// REST API) so the avatar can answer "what's the latest..." questions without
// a paid search key. It returns a compact snippet block that gets fed back to
// the LLM. If SEARCH_API_URL is set (e.g. a Bing/Brave-compatible endpoint),
// that is used instead. The chat route only calls this when the LLM asks for
// it via {"tool":"web_search","query":"..."}, so it can't be abused remotely.

const SEARCH_TIMEOUT_MS = 8000;

/** Current local time + date, formatted for the system prompt. */
export function currentTimeBlock() {
  const now = new Date();
  return `[Current time: ${now.toLocaleString()} — you can use this to answer questions about dates, times, and scheduling.]`;
}

/**
 * Search the web for a query and return a compact text block of results
 * (Wikipedia-backed by default). Returns null on failure so the chat loop
 * can fall back gracefully.
 */
export async function webSearch(query) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) return null;
  try {
    const apiUrl = (process.env.SEARCH_API_URL || "https://en.wikipedia.org/w/api.php")
      .trim();

    const params =
      apiUrl.includes("wikipedia.org")
        ? new URLSearchParams({
            action: "query",
            list: "search",
            srsearch: q,
            srlimit: "4",
            format: "json",
            origin: "*",
          })
        : new URLSearchParams({ q });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    const response = await fetch(`${apiUrl}?${params}`, {
      signal: controller.signal,
      headers: { "User-Agent": "avatar-ai/1.0" },
    });
    clearTimeout(timer);
    if (!response.ok) return null;

    const data = await response.json();
    const lines = [];

    if (data?.query?.search) {
      for (const s of data.query.search.slice(0, 4)) {
        const title = s.title;
        const snippet = String(s.snippet || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        lines.push(`• ${title}: ${snippet.slice(0, 400)}`);
      }
    } else if (Array.isArray(data)) {
      for (const r of data.slice(0, 4)) {
        const title = r.title || r.name || "result";
        const url = r.url || r.link || "";
        const snippet = String(r.snippet || r.description || r.snippet_text || "")
          .replace(/\s+/g, " ")
          .trim();
        lines.push(`• ${title}${url ? ` (${url})` : ""}: ${snippet.slice(0, 400)}`);
      }
    }

    if (lines.length === 0) return null;
    return `[WEB SEARCH RESULTS for "${q}"]\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}
