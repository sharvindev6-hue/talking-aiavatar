import { AvatarController } from "./avatar.js";
import { ChatClient } from "./chat.js";
import { ElevenLabsTTS } from "./tts.js";
import { SpeechRecognizer } from "./stt.js";

const els = {
  stage: document.getElementById("avatar-stage"),
  loading: document.getElementById("avatar-loading"),
  statusChip: document.getElementById("status-chip"),
  connectionStatus: document.getElementById("connection-status"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("message-input"),
  sendBtn: document.getElementById("send-btn"),
  micBtn: document.getElementById("mic-btn"),
  interruptBtn: document.getElementById("interrupt-btn"),
  newChatBtn: document.getElementById("new-chat-btn"),
  historyBtn: document.getElementById("history-btn"),
  historyClose: document.getElementById("history-close"),
  historyOverlay: document.getElementById("history-overlay"),
  historyDrawer: document.getElementById("history-drawer"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  memoryBtn: document.getElementById("memory-btn"),
  memoryClose: document.getElementById("memory-close"),
  memoryOverlay: document.getElementById("memory-overlay"),
  memoryDrawer: document.getElementById("memory-drawer"),
  memoryList: document.getElementById("memory-list"),
  memoryEmpty: document.getElementById("memory-empty"),
  memoryForgetAll: document.getElementById("memory-forget-all"),
  skillsBtn: document.getElementById("skills-btn"),
  skillsClose: document.getElementById("skills-close"),
  skillsOverlay: document.getElementById("skills-overlay"),
  skillsDrawer: document.getElementById("skills-drawer"),
  skillsList: document.getElementById("skills-list"),
  skillsEmpty: document.getElementById("skills-empty"),
  remindersBtn: document.getElementById("reminders-btn"),
  remindersClose: document.getElementById("reminders-close"),
  remindersOverlay: document.getElementById("reminders-overlay"),
  remindersDrawer: document.getElementById("reminders-drawer"),
  remindersList: document.getElementById("reminders-list"),
  remindersEmpty: document.getElementById("reminders-empty"),
  userEmail: document.getElementById("user-email"),
  logoutBtn: document.getElementById("logout-btn"),
  attachBtn: document.getElementById("attach-btn"),
  fileInput: document.getElementById("file-input"),
  attachmentPreview: document.getElementById("attachment-preview"),
};

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_MB = 4;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// Loaded on demand (CDN, like three.js) only when a PDF is attached.
const PDFJS_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFJS_WORKER_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const TEXT_FILE_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
]);
const TEXT_FILE_EXTS = ["txt", "md", "csv", "json", "log", "py", "js", "ts", "html", "xml", "yaml", "yml"];
const MAX_EXTRACTED_CHARS = 20000; // cap on text sent to the model

let pendingAttachments = []; // [{ name, type, size, dataUrl, previewUrl }]

const STATUS_LABELS = {
  idle: "Ready",
  thinking: "Thinking…",
  speaking: "Speaking…",
  listening: "Listening…",
};

let avatar;
let chat;
let tts;
let stt;
let busy = false;
let config = { ready: false };
let currentUser = null;
let currentSessionId = null;
let sessions = [];

function setStatus(state) {
  els.statusChip.dataset.state = state;
  els.statusChip.textContent = STATUS_LABELS[state] || state;
}

function setBusy(value) {
  busy = value;
  els.input.disabled = value || !config.ready;
  els.sendBtn.disabled = value || !config.ready;
  els.interruptBtn.hidden = !value;
}

function showSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "message assistant system-notice";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "System";
  const body = document.createElement("span");
  body.textContent = text;
  div.append(label, body);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Very light Markdown so AI answers look clean: **bold**, *italic*, line breaks. */
function renderMarkdown(text) {
  return escapeHtml(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

function appendMessage(role, text, { streaming = false, attachments = [] } = {}) {
  const div = document.createElement("div");
  div.className = `message ${role}${streaming ? " streaming" : ""}`;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = role === "user" ? "You" : "Avatar";
  div.appendChild(label);

  if (attachments.length > 0) {
    div.appendChild(renderAttachments(attachments));
  }

  // Always create the body element (even when empty) so streaming updates
  // have a target to write into.
  const body = document.createElement("span");
  body.className = "message-body";
  body.innerHTML = renderMarkdown(text);
  div.appendChild(body);

  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return { div, body };
}

function renderAttachments(attachments) {
  const wrap = document.createElement("div");
  wrap.className = "message-attachments";
  for (const att of attachments) {
    if (IMAGE_TYPES.has(att.type) && att.dataUrl) {
      const img = document.createElement("img");
      img.className = "attachment-image";
      img.src = att.dataUrl;
      img.alt = att.name || "attached image";
      img.loading = "lazy";
      wrap.appendChild(img);
    } else {
      const chip = document.createElement("a");
      chip.className = "attachment-chip";
      chip.href = att.dataUrl || "#";
      chip.download = att.name || "file";
      chip.target = "_blank";
      chip.rel = "noopener";
      const icon = document.createElement("span");
      icon.className = "attachment-chip-icon";
      icon.textContent = fileIcon(att.name || att.type || "");
      const meta = document.createElement("span");
      meta.className = "attachment-chip-meta";
      meta.textContent = `${att.name || "file"}${att.size ? ` · ${formatBytes(att.size)}` : ""}`;
      chip.append(icon, meta);
      if (att.extractedText) {
        const ok = document.createElement("span");
        ok.className = "attachment-chip-ok";
        ok.textContent = "✓";
        ok.title = "Text extracted";
        chip.appendChild(ok);
      }
      wrap.appendChild(chip);
    }
  }
  return wrap;
}

function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["pdf"].includes(ext)) return "📕";
  if (["doc", "docx"].includes(ext)) return "📘";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📗";
  if (["ppt", "pptx"].includes(ext)) return "📙";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜";
  if (["txt", "md"].includes(ext)) return "📄";
  return "📎";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clearMessages() {
  els.messages.replaceChildren();
}

// ---------- Attachments ----------

async function handleFiles(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;

  for (const file of list) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      showSystemMessage(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      break;
    }
    if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      showSystemMessage(`"${file.name}" is over ${MAX_ATTACHMENT_MB} MB — skipped.`);
      continue;
    }
    try {
      // Images are compressed client-side so uploads stay small enough for
      // both local and Vercel (serverless bodies cap around 4.5 MB).
      const { dataUrl, size, mime } = await fileToDataUrl(file, { compressImages: true });
      const att = {
        name: file.name,
        type: mime || file.type || "application/octet-stream",
        size,
        dataUrl,
      };

      // Extract document content so the avatar can actually read it.
      if (isPdfFile(file)) {
        Object.assign(att, await extractPdfContent(file));
      } else if (isTextFile(file)) {
        att.extractedText = (await file.text()).slice(0, MAX_EXTRACTED_CHARS);
      }

      pendingAttachments.push(att);
    } catch (err) {
      console.error("Failed to read file:", err);
    }
  }
  renderAttachmentPreview();
}

const IMAGE_MAX_DIMENSION = 1280; // px
const IMAGE_QUALITY = 0.82;

function fileToDataUrl(file, { compressImages = false } = {}) {
  return new Promise((resolve, reject) => {
    if (compressImages && file.type?.startsWith("image/") && file.type !== "image/gif") {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
            const scale = IMAGE_MAX_DIMENSION / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
        URL.revokeObjectURL(url);
        // Approximate byte size from base64 length.
        const size = Math.round((dataUrl.length - 22) * 0.75);
        resolve({ dataUrl, size, mime: "image/jpeg", compressed: true });
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };
      img.src = url;
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const size = file.size || Math.round((dataUrl.length - 22) * 0.75);
      const mimeMatch = dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);/i);
      resolve({ dataUrl, size, mime: mimeMatch?.[1]?.toLowerCase() });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderAttachmentPreview() {
  if (pendingAttachments.length === 0) {
    els.attachmentPreview.hidden = true;
    els.attachmentPreview.replaceChildren();
    return;
  }
  els.attachmentPreview.hidden = false;
  els.attachmentPreview.replaceChildren();

  for (let i = 0; i < pendingAttachments.length; i++) {
    const att = pendingAttachments[i];
    const item = document.createElement("div");
    item.className = "attachment-preview-item";

    if (IMAGE_TYPES.has(att.type)) {
      const img = document.createElement("img");
      img.className = "attachment-preview-thumb";
      img.src = att.dataUrl;
      img.alt = att.name;
      item.appendChild(img);
    } else if (att.pageImages?.length > 0) {
      // Scanned PDF — show the first rasterized page as the thumbnail.
      const img = document.createElement("img");
      img.className = "attachment-preview-thumb";
      img.src = att.pageImages[0];
      img.alt = att.name;
      item.appendChild(img);
    } else {
      const chip = document.createElement("span");
      chip.className = "attachment-preview-file";
      chip.textContent = `${fileIcon(att.name)} ${att.name}`;
      if (att.extractedText) {
        const ok = document.createElement("span");
        ok.className = "attachment-preview-badge";
        ok.textContent = "✓ text";
        chip.appendChild(ok);
      }
      item.appendChild(chip);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-preview-remove";
    remove.setAttribute("aria-label", `Remove ${att.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingAttachments.splice(i, 1);
      renderAttachmentPreview();
    });
    item.appendChild(remove);
    els.attachmentPreview.appendChild(item);
  }
}

function clearPendingAttachments() {
  pendingAttachments = [];
  renderAttachmentPreview();
  els.fileInput.value = "";
}

function isPdfFile(file) {
  return file.type === "application/pdf" || /\\.pdf$/i.test(file.name);
}

function isTextFile(file) {
  if (TEXT_FILE_TYPES.has(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return TEXT_FILE_EXTS.includes(ext);
}

/**
 * Extract text from a PDF. If the PDF is a scan (no selectable text),
 * render its pages to images so the vision model can read them.
 */
async function extractPdfContent(file) {
  try {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = "";
    const pageImages = [];
    const pageCount = Math.min(doc.numPages, 10);

    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it) => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      text += pageText ? pageText + "\n\n" : "";

      // If a page has no extractable text (a scan), rasterize it instead.
      if (!pageText && pageImages.length < 3) {
        const viewport = page.getViewport({ scale: 1.6 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(viewport.width, 1400);
        canvas.height = Math.round(canvas.width * (viewport.height / viewport.width));
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        pageImages.push(canvas.toDataURL("image/jpeg", 0.82));
      }
    }

    const result = { extractedText: text.trim().slice(0, MAX_EXTRACTED_CHARS) || null };
    if (pageImages.length > 0) result.pageImages = pageImages;
    return result;
  } catch (err) {
    console.error("PDF extraction failed:", err);
    return { extractedText: null };
  }
}

function updateStreamingMessage(body, text) {
  body.innerHTML = renderMarkdown(text);
  body.parentElement.classList.add("streaming");
  els.messages.scrollTop = els.messages.scrollHeight;
}

function finalizeStreamingMessage(body, text) {
  body.innerHTML = renderMarkdown(text);
  body.parentElement.classList.remove("streaming");
}

async function checkConnection() {
  els.connectionStatus.textContent = "Checking…";
  els.connectionStatus.className = "connection-status";

  try {
    const res = await fetch("/api/status");
    config = await res.json();

    const parts = [];
    if (config.nvidia) parts.push("Kimi OK");
    else parts.push(`Kimi: ${config.nvidiaError || "failed"}`);

    if (config.elevenlabs) parts.push("ElevenLabs OK");
    else parts.push(`ElevenLabs: ${config.elevenlabsError || "failed"}`);

    els.connectionStatus.textContent = parts.join(" · ");
    els.connectionStatus.className = `connection-status ${config.ready ? "ok" : "error"}`;

    tts = new ElevenLabsTTS();
    avatar?.setA2FEnabled(config.a2fEnabled);

    els.input.disabled = !config.ready;
    els.sendBtn.disabled = !config.ready;

    if (!config.ready) {
      showSystemMessage(
        [
          !config.nvidia && `Brain (Kimi): ${config.nvidiaError}`,
          !config.elevenlabs && `Voice (ElevenLabs): ${config.elevenlabsError}`,
          !config.elevenlabs &&
            "Update ELEVENLABS_API_KEY in avatar-ai/.env with a valid key from elevenlabs.io → Profile → API Keys.",
        ]
          .filter(Boolean)
          .join("\n\n")
      );
    }

    return config.ready;
  } catch {
    els.connectionStatus.textContent = "Server offline";
    els.connectionStatus.className = "connection-status error";
    showSystemMessage("Cannot reach the server. Run: cd avatar-ai && npm start");
    return false;
  }
}

// ---------- History / sessions ----------

async function ensureSession() {
  if (currentSessionId) return currentSessionId;
  const res = await fetch("/api/history/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Could not create a chat session");
  }
  const { session } = await res.json();
  currentSessionId = session.id;
  return session.id;
}

async function loadSessions() {
  try {
    const res = await fetch("/api/history/sessions");
    if (!res.ok) return;
    const data = await res.json();
    sessions = data.sessions || [];
    renderHistoryList();
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

function formatSessionTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  const diff = now - date;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderHistoryList() {
  els.historyList.replaceChildren();
  els.historyEmpty.hidden = sessions.length > 0;

  for (const session of sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `history-item${session.id === currentSessionId ? " active" : ""}`;
    item.setAttribute("aria-label", `Open conversation: ${session.title}`);

    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = session.title || "New chat";

    const meta = document.createElement("span");
    meta.className = "history-item-meta";
    meta.textContent = `${session.messageCount || 0} messages · ${formatSessionTime(session.updatedAt)}`;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-item-delete";
    del.title = "Delete conversation";
    del.setAttribute("aria-label", `Delete conversation: ${session.title}`);
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${session.title}"?`)) return;
      try {
        const res = await fetch(`/api/history/sessions/${session.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
        if (currentSessionId === session.id) {
          currentSessionId = null;
          clearMessages();
        }
        await loadSessions();
      } catch (err) {
        console.error(err);
      }
    });

    item.append(title, meta, del);
    item.addEventListener("click", () => openSession(session.id));
    els.historyList.appendChild(item);
  }
}

async function openSession(sessionId) {
  try {
    const res = await fetch(`/api/history/sessions/${sessionId}`);
    if (!res.ok) throw new Error("load failed");
    const { session, messages } = await res.json();

    currentSessionId = session.id;
    clearMessages();

    for (const m of messages) {
      if (m.role === "user") {
        appendMessage("user", m.content, { attachments: m.attachments || [] });
      } else {
        appendMessage("assistant", m.content);
      }
    }

    renderHistoryList();
    closeHistory();
  } catch (err) {
    console.error("Failed to open session:", err);
    showSystemMessage(`Could not load conversation: ${err.message}`);
  }
}

function openHistory() {
  loadSessions();
  els.historyDrawer.classList.add("open");
  els.historyDrawer.setAttribute("aria-hidden", "false");
  els.historyOverlay.hidden = false;
}

function closeHistory() {
  els.historyDrawer.classList.remove("open");
  els.historyDrawer.setAttribute("aria-hidden", "true");
  els.historyOverlay.hidden = true;
}

// ---------- Memory drawer ----------

async function loadMemory() {
  try {
    const res = await fetch("/api/memory");
    if (!res.ok) return;
    const data = await res.json();
    renderMemoryList(data.facts || []);
  } catch (err) {
    console.error("Failed to load memory:", err);
  }
}

function renderMemoryList(facts) {
  els.memoryList.replaceChildren();
  els.memoryEmpty.hidden = facts.length > 0;
  els.memoryForgetAll.hidden = facts.length === 0;

  for (const fact of facts) {
    const item = document.createElement("div");
    item.className = "memory-item";

    const text = document.createElement("span");
    text.className = "memory-item-text";
    text.textContent = fact.fact;

    const meta = document.createElement("span");
    meta.className = "memory-item-meta";
    if (fact.category && fact.category !== "other") {
      meta.textContent = fact.category;
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-item-delete memory-item-delete";
    del.title = "Forget this";
    del.setAttribute("aria-label", `Forget: ${fact.fact}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/memory/facts/${fact.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
        await loadMemory();
      } catch (err) {
        console.error(err);
      }
    });

    item.append(text, meta, del);
    els.memoryList.appendChild(item);
  }
}

function openMemory() {
  loadMemory();
  els.memoryDrawer.classList.add("open");
  els.memoryDrawer.setAttribute("aria-hidden", "false");
  els.memoryOverlay.hidden = false;
}

function closeMemory() {
  els.memoryDrawer.classList.remove("open");
  els.memoryDrawer.setAttribute("aria-hidden", "true");
  els.memoryOverlay.hidden = true;
}

// ---------- Skills drawer ----------

async function loadSkills() {
  try {
    const res = await fetch("/api/skills");
    if (!res.ok) return;
    const data = await res.json();
    renderSkillsList(data.skills || []);
  } catch (err) {
    console.error("Failed to load skills:", err);
  }
}

function renderSkillsList(skills) {
  els.skillsList.replaceChildren();
  els.skillsEmpty.hidden = skills.length > 0;

  for (const skill of skills) {
    const item = document.createElement("div");
    item.className = "memory-item";

    const text = document.createElement("span");
    text.className = "memory-item-text";
    text.textContent = skill.name;

    const desc = document.createElement("span");
    desc.className = "memory-item-meta";
    desc.textContent = skill.description || skill.trigger || "skill";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-item-delete memory-item-delete";
    del.title = "Delete skill";
    del.setAttribute("aria-label", `Delete skill: ${skill.name}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/skills/${skill.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
        await loadSkills();
      } catch (err) {
        console.error(err);
      }
    });

    item.append(text, desc, del);
    els.skillsList.appendChild(item);
  }
}

function openSkills() {
  loadSkills();
  els.skillsDrawer.classList.add("open");
  els.skillsDrawer.setAttribute("aria-hidden", "false");
  els.skillsOverlay.hidden = false;
}

function closeSkills() {
  els.skillsDrawer.classList.remove("open");
  els.skillsDrawer.setAttribute("aria-hidden", "true");
  els.skillsOverlay.hidden = true;
}

// ---------- Reminders drawer + poller ----------

async function loadReminders() {
  try {
    const res = await fetch("/api/reminders");
    if (!res.ok) return;
    const data = await res.json();
    renderRemindersList(data.reminders || []);
  } catch (err) {
    console.error("Failed to load reminders:", err);
  }
}

function renderRemindersList(reminders) {
  els.remindersList.replaceChildren();
  els.remindersEmpty.hidden = reminders.length > 0;

  for (const r of reminders) {
    const item = document.createElement("div");
    item.className = "memory-item";

    const text = document.createElement("span");
    text.className = "memory-item-text";
    text.textContent = r.message;

    const when = document.createElement("span");
    when.className = "memory-item-meta";
    when.textContent = `⏰ ${formatReminderTime(r.nextFireAt)}`;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-item-delete memory-item-delete";
    del.title = "Cancel reminder";
    del.setAttribute("aria-label", `Cancel reminder: ${r.message}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/reminders/${r.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
        await loadReminders();
      } catch (err) {
        console.error(err);
      }
    });

    item.append(text, when, del);
    els.remindersList.appendChild(item);
  }
}

function formatReminderTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function openReminders() {
  loadReminders();
  els.remindersDrawer.classList.add("open");
  els.remindersDrawer.setAttribute("aria-hidden", "false");
  els.remindersOverlay.hidden = false;
}

function closeReminders() {
  els.remindersDrawer.classList.remove("open");
  els.remindersDrawer.setAttribute("aria-hidden", "true");
  els.remindersOverlay.hidden = true;
}

/**
 * Poll for due reminders while the app is open. When one fires, announce it
 * as a system message and speak it through the avatar. Runs every 20s.
 */
function startReminderPoller() {
  setInterval(async () => {
    if (document.visibilityState !== "visible" || busy) return;
    try {
      const res = await fetch("/api/reminders/due");
      if (!res.ok) return;
      const { due } = await res.json();
      for (const r of due || []) {
        const text = `⏰ Reminder: ${r.message}`;
        showSystemMessage(text);
        loadReminders(); // keep the drawer fresh
        if (config.elevenlabs && avatar?.head) {
          setStatus("speaking");
          await speakResponse({ say: `Reminder: ${r.message}`, emotion: "neutral", gesture: "none" });
          setStatus("idle");
        }
      }
    } catch (err) {
      /* poller is best-effort */
    }
  }, 20_000);
}

async function startNewChat() {
  interruptAll();
  clearMessages();
  currentSessionId = null;
  await ensureSession();
  renderHistoryList();
  els.input.focus();
}

// ---------- Speech ----------

async function speakResponse(structured) {
  // Don't read Markdown symbols aloud (e.g. "**Question 1**").
  const say = (structured.say || "").replace(/\*\*/g, "").replace(/\*/g, "").trim();
  if (!say || !config.elevenlabs || !avatar?.head) return;

  await avatar.speakWithMetadata(structured);

  let wordsSent = false;

  await tts.speak(say, {
    onAudioChunk: (chunk) => avatar.feedAudioChunk(chunk),
    onWords: (words, times, durations) => {
      avatar.feedWords(words, times, durations);
      wordsSent = true;
    },
    onEnd: () => avatar.notifySpeechEnd(),
    onError: (err) => console.error("TTS error:", err),
  });

  if (!wordsSent) {
    avatar.feedWords(say.split(/\s+/), [0], [say.length * 50]);
    avatar.notifySpeechEnd();
  }
}

function interruptAll() {
  tts?.stop();
  chat?.stop();
  avatar?.interrupt();
  stt?.stop();
  setBusy(false);
  if (!busy) setStatus("idle");
}

const SLASH_COMMANDS = {
  "/new": { run: startNewChat, hint: "Start a new conversation" },
  "/memory": { run: openMemory, hint: "Show what the avatar remembers" },
  "/skills": { run: openSkills, hint: "Show saved skills" },
  "/reminders": { run: openReminders, hint: "Show your reminders" },
  "/help": { run: showHelp, hint: "List available commands" },
};

function showHelp() {
  const lines = Object.entries(SLASH_COMMANDS)
    .map(([cmd, c]) => `${cmd} — ${c.hint}`);
  showSystemMessage(`Available commands:\n${lines.join("\n")}`);
}

async function handleUserMessage(text) {
  const trimmed = text.trim();
  if ((!trimmed && pendingAttachments.length === 0) || busy || !config.ready) return;

  // Hermes-style slash commands run locally and never hit the LLM.
  const cmd = SLASH_COMMANDS[trimmed.split(/\s+/)[0]?.toLowerCase()];
  if (cmd) {
    appendMessage("user", trimmed, {});
    els.input.value = "";
    await cmd.run();
    return;
  }

  interruptAll();
  const attachments = pendingAttachments;
  clearPendingAttachments();

  appendMessage("user", trimmed, { attachments });
  els.input.value = "";
  setBusy(true);
  setStatus("thinking");

  const assistantEl = appendMessage("assistant", "", { streaming: true });
  const assistantBody = assistantEl.body;
  let displayText = "";

  try {
    const sessionId = await ensureSession();
    const structured = await chat.sendMessage(sessionId, trimmed, attachments, {
      onToken: (_delta, full) => {
        displayText = full;
        updateStreamingMessage(assistantBody, structuredPreview(full));
      },
      onComplete: (parsed) => {
        finalizeStreamingMessage(assistantBody, parsed.say || displayText);
      },
    });

    if (config.elevenlabs) {
      setStatus("speaking");
      await speakResponse(structured);
    }

    // Refresh history list so titles/counts stay fresh.
    loadSessions();
  } catch (err) {
    if (err.message !== "Stopped") {
      finalizeStreamingMessage(assistantBody, `Error: ${err.message}`);
      console.error(err);
      // Restore the attachments so the user doesn't lose their files.
      if (attachments.length > 0) {
        pendingAttachments = [...attachments, ...pendingAttachments].slice(0, MAX_ATTACHMENTS);
        renderAttachmentPreview();
      }
    }
  } finally {
    setBusy(false);
    setStatus("idle");
  }
}

function structuredPreview(raw) {
  try {
    // While the model is mid-tool-call it emits JSON like
    // {"tool":"web_search","query":"..."} — don't flash that at the user.
    if (/{\s*"tool"\s*:\s*"web_search"/.test(raw)) return "";
    const match = raw.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (match) return match[1].replace(/\\"/g, '"');
  } catch {
    /* ignore */
  }
  return raw;
}

// ---------- Voice input ----------

function setupSTT() {
  stt = new SpeechRecognizer({
    onStart: () => {
      interruptAll();
      setStatus("listening");
      els.micBtn.classList.add("active");
    },
    onResult: ({ interim, final }) => {
      if (final) {
        els.input.value = final;
        handleUserMessage(final);
      } else if (interim) {
        els.input.value = interim;
      }
    },
    onEnd: () => {
      els.micBtn.classList.remove("active");
      if (!busy) setStatus("idle");
    },
    onError: (err) => {
      console.warn("STT error:", err);
      els.micBtn.classList.remove("active");
      setStatus("idle");
    },
  });

  if (!stt.supported) {
    els.micBtn.disabled = true;
    els.micBtn.title = "Speech recognition not supported in this browser";
  }
}

// ---------- Avatar ----------

async function initAvatar() {
  avatar = new AvatarController(els.stage, { onStateChange: setStatus });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Avatar load timed out (30s)")), 30000)
  );

  try {
    await Promise.race([avatar.init(), timeout]);
    els.loading.classList.add("hidden");
  } catch (err) {
    els.loading.textContent = `Avatar error: ${err.message}`;
    console.error(err);
    showSystemMessage(
      `3D avatar failed to load: ${err.message}. Chat may still work if API keys are valid.`
    );
  }
}

// ---------- Auth ----------

async function ensureAuthenticated() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/login.html";
      return false;
    }
    const { user } = await res.json();
    currentUser = user;
    els.userEmail.textContent = user.email;
    return true;
  } catch {
    window.location.href = "/login.html";
    return false;
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login.html";
  }
}

// ---------- Init ----------

async function init() {
  const authed = await ensureAuthenticated();
  if (!authed) return;

  chat = new ChatClient();
  setupSTT();

  await Promise.all([initAvatar(), checkConnection(), startNewChat()]);

  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    handleUserMessage(els.input.value);
  });

  els.micBtn.addEventListener("click", () => {
    if (stt.isListening()) stt.stop();
    else stt.start();
  });

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => {
    handleFiles(e.target.files);
    els.fileInput.value = "";
  });

  // Allow pasting images directly into the input.
  els.input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  });

  els.interruptBtn.addEventListener("click", interruptAll);
  els.newChatBtn.addEventListener("click", startNewChat);
  els.historyBtn.addEventListener("click", openHistory);
  els.historyClose.addEventListener("click", closeHistory);
  els.historyOverlay.addEventListener("click", closeHistory);
  els.memoryBtn.addEventListener("click", openMemory);
  els.memoryClose.addEventListener("click", closeMemory);
  els.memoryOverlay.addEventListener("click", closeMemory);
  els.skillsBtn.addEventListener("click", openSkills);
  els.skillsClose.addEventListener("click", closeSkills);
  els.skillsOverlay.addEventListener("click", closeSkills);
  els.remindersBtn.addEventListener("click", openReminders);
  els.remindersClose.addEventListener("click", closeReminders);
  els.remindersOverlay.addEventListener("click", closeReminders);
  els.memoryForgetAll.addEventListener("click", async () => {
    if (!confirm("Forget everything the avatar remembers about you?")) return;
    try {
      const res = await fetch("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("forget failed");
      await loadMemory();
    } catch (err) {
      console.error(err);
    }
  });
  els.logoutBtn.addEventListener("click", logout);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.historyDrawer.classList.contains("open")) {
      closeHistory();
    }
    if (e.key === "Escape" && els.memoryDrawer.classList.contains("open")) {
      closeMemory();
    }
    if (e.key === "Escape" && els.skillsDrawer.classList.contains("open")) {
      closeSkills();
    }
    if (e.key === "Escape" && els.remindersDrawer.classList.contains("open")) {
      closeReminders();
    }
  });

  startReminderPoller();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") avatar?.head?.start();
    else avatar?.head?.stop();
  });
}

init().catch((err) => {
  console.error("Init failed:", err);
  showSystemMessage(`Startup error: ${err.message}`);
});
