// Admin dashboard — analytics + per-user chat history for the operator.
const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  view: "overview",
  users: { q: "", limit: 25, offset: 0, total: 0 },
  feed: { q: "", limit: 60 },
  drawer: null, // { userId, offset, limit, loaded }
  feedTimer: null,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const fmtNum = (n) => new Intl.NumberFormat().format(n ?? 0);

const initials = (email) =>
  (email || "?").replace(/@.*$/, "").slice(0, 2).toUpperCase() || "?";

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- Auth gate ---------------- */
async function gate() {
  let me;
  try {
    me = await api("/api/admin/me");
  } catch (err) {
    if (err.status === 401) {
      window.location.href = "/admin-login.html";
      return false;
    }
    renderWall("Server unreachable. Is it running?");
    return false;
  }
  state.user = { email: me.email };
  $("who-avatar").textContent = initials(me.email);
  $("who-mail").textContent = me.email;
  document.title = `Admin · ${me.email}`;
  return true;
}

function renderWall(message, showSignOut = false) {
  document.body.innerHTML = `
    <div class="auth-wall">
      <div class="panel">
        <div class="brand-logo" style="margin:0 auto;width:3rem;height:3rem;display:grid;place-items:center;border-radius:1rem;background:linear-gradient(135deg,rgba(59,158,255,.25),rgba(59,158,255,.06));border:1px solid rgba(59,158,255,.35);color:var(--accent)">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z"/><path d="M9.5 12l1.8 1.8L15 10"/></svg>
        </div>
        <h1>Admin access required</h1>
        <p>${esc(message)}</p>
        ${showSignOut ? `<a class="btn-primary" href="/admin-login.html">Back to admin login</a>` : ""}
      </div>
    </div>`;
}

/* ---------------- Navigation ---------------- */
function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  document.querySelectorAll(".view").forEach((s) =>
    s.classList.toggle("active", s.id === `view-${view}`)
  );
  if (view === "overview") loadOverview();
  if (view === "users") loadUsers();
  if (view === "feed") loadFeed();
}

/* ---------------- Overview ---------------- */
const ICONS = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/></svg>',
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.4-3.6A8 8 0 1 1 21 12z"/></svg>',
  active: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h16"/><path d="M8 16v-5M13 16V8M18 16v-3"/></svg>',
  new: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
};

function statCard(label, value, sub, color, icon) {
  return `
    <div class="stat-card" style="--card-accent:${color}">
      <div class="stat-label">${icon}${esc(label)}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub ${sub.cls || ""}">${sub.text}</div>` : ""}
    </div>`;
}

async function loadOverview() {
  try {
    const s = await api("/api/admin/stats");
    const grid = $("stat-grid");
    grid.innerHTML =
      statCard("Total users", fmtNum(s.users), { text: `+${fmtNum(s.new_users_7d)} this week`, cls: "good" }, "#3b9eff", ICONS.users) +
      statCard("Messages", fmtNum(s.messages), { text: `+${fmtNum(s.messages_24h)} in 24h`, cls: "good" }, "#a78bfa", ICONS.messages) +
      statCard("Active now", fmtNum(s.active_5m), { text: "chatted in last 5 min", cls: s.active_5m ? "good" : "" }, "#34d399", ICONS.active) +
      statCard("Active 24h", fmtNum(s.active_24h), { text: `${Math.round((s.active_24h / Math.max(s.users, 1)) * 100)}% of users`, cls: "good" }, "#fbbf24", ICONS.active) +
      statCard("Sessions", fmtNum(s.sessions), { text: `${fmtNum(Math.round(s.sessions / Math.max(s.users, 1)))} per user` }, "#38bdf8", ICONS.sessions) +
      statCard("New users", fmtNum(s.new_users_24h), { text: "in last 24h", cls: "warn" }, "#f472b6", ICONS.new);

    renderChart(s.daily || []);

    const tu = s.topUsers || [];
    const max = Math.max(...tu.map((u) => u.messages), 1);
    $("top-users").innerHTML = tu.length
      ? tu
          .map(
            (u, i) => `
        <div class="top-user">
          <div class="rank">${i + 1}</div>
          <div class="tu-mail">${esc(u.email)}</div>
          <div class="tu-bar-track"><div class="tu-bar" style="width:${Math.round((u.messages / max) * 100)}%"></div></div>
          <div class="tu-count">${fmtNum(u.messages)}</div>
        </div>`
          )
          .join("")
      : `<div class="empty">No messages yet</div>`;

    loadFeedInto($("overview-feed"), 8);
  } catch (err) {
    toast(err.message);
  }
}

function renderChart(daily) {
  const max = Math.max(...daily.map((d) => d.count), 1);
  const chart = $("chart");
  chart.innerHTML = daily
    .map((d) => {
      const h = Math.max((d.count / max) * 100, d.count ? 6 : 2);
      const label = new Date(d.day + "T00:00:00Z").toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });
      return `
        <div class="chart-col">
          <div class="chart-bar ${d.count ? "" : "zero"}" style="height:${h}%">
            <span class="tip">${label}: ${fmtNum(d.count)}</span>
          </div>
          <div class="chart-day">${d.day.slice(8)}</div>
        </div>`;
    })
    .join("");
}

/* ---------------- Feed ---------------- */
async function loadFeedInto(container, limit, q) {
  try {
    const query = q === undefined ? state.feed.q : q;
    const data = await api(`/api/admin/feed?q=${encodeURIComponent(query)}&limit=${limit}`);
    renderFeed(container, data.feed);
  } catch (err) {
    toast(err.message);
  }
}

function renderFeed(container, feed) {
  container.innerHTML = feed.length
    ? feed
        .map(
          (m) => `
      <div class="feed-item" data-uid="${esc(m.userId)}" title="Click to view this user">
        <div class="feed-avatar">${initials(m.userEmail)}</div>
        <div class="feed-main">
          <div class="feed-top">
            <span class="feed-mail">${esc(m.userEmail)}</span>
            <span class="role-chip ${esc(m.role)}">${esc(m.role)}</span>
            ${m.sessionTitle ? `<span class="feed-session">${esc(m.sessionTitle)}</span>` : ""}
            <span class="feed-time">${fmtTime(m.createdAt)}</span>
          </div>
          <div class="feed-content">${esc(m.content)}</div>
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty">No activity yet</div>`;
  container.querySelectorAll(".feed-item").forEach((el) =>
    el.addEventListener("click", () => openUser(el.dataset.uid))
  );
}

async function loadFeed() {
  await loadFeedInto($("feed-list"), state.feed.limit);
  if (state.feedTimer) clearInterval(state.feedTimer);
  state.feedTimer = setInterval(async () => {
    // Only auto-refresh when the feed tab is active.
    if (state.view === "feed") await loadFeedInto($("feed-list"), state.feed.limit);
  }, 6000);
}

/* ---------------- Users ---------------- */
async function loadUsers() {
  const body = $("users-body");
  body.innerHTML = `<tr><td colspan="6" class="empty">Loading…</td></tr>`;
  try {
    const q = state.users.q;
    const data = await api(
      `/api/admin/users?q=${encodeURIComponent(q)}&limit=${state.users.limit}&offset=${state.users.offset}`
    );
    state.users.total = data.total;
    $("users-count").textContent = `${fmtNum(data.total)} account${data.total === 1 ? "" : "s"}`;

    body.innerHTML = data.users.length
      ? data.users
          .map(
            (u) => `
        <tr data-uid="${esc(u.id)}">
          <td>
            <div class="user-cell">
              <div class="who-avatar">${initials(u.email)}</div>
              <div>
                <div class="mail">${esc(u.email)}</div>
                ${u.isAdmin ? '<span class="admin-tag">ADMIN</span>' : ""}
              </div>
            </div>
          </td>
          <td>${fmtTime(u.createdAt)}</td>
          <td class="num">${fmtNum(u.sessions)}</td>
          <td class="num">${fmtNum(u.messages)}</td>
          <td>${fmtTime(u.lastActive)}</td>
          <td class="arrow-cell"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="6" class="empty">No users found</td></tr>`;

    body.querySelectorAll("tr[data-uid]").forEach((tr) =>
      tr.addEventListener("click", () => openUser(tr.dataset.uid))
    );

    renderPager();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${esc(err.message)}</td></tr>`;
  }
}

function renderPager() {
  const { limit, offset, total } = state.users;
  const pages = Math.max(Math.ceil(total / limit), 1);
  const page = Math.floor(offset / limit) + 1;
  $("users-pager").innerHTML = `
    <button id="pg-prev" ${page <= 1 ? "disabled" : ""}>← Prev</button>
    <span class="pager-info">Page ${page} of ${pages}</span>
    <button id="pg-next" ${page >= pages ? "disabled" : ""}>Next →</button>`;
  $("pg-prev")?.addEventListener("click", () => {
    state.users.offset = Math.max(0, state.users.offset - state.users.limit);
    loadUsers();
  });
  $("pg-next")?.addEventListener("click", () => {
    if ((state.users.offset + state.users.limit) < state.users.total) {
      state.users.offset += state.users.limit;
      loadUsers();
    }
  });
}

/* ---------------- User drawer ---------------- */
const DRAWER_PAGE = 60;

async function openUser(userId) {
  const overlay = $("overlay");
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  const body = $("drawer-body");
  body.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const data = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
    $("drawer-email").textContent = data.user.email;
    $("drawer-avatar").textContent = initials(data.user.email);
    $("drawer-meta").textContent = `${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"} · joined ${fmtTime(data.user.created_at)}`;
    state.drawer = { userId, offset: 0, loaded: 0 };
    body.innerHTML = `<div class="section-title">Messages</div>`;
    await drawerLoadMore();
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function drawerLoadMore() {
  const body = $("drawer-body");
  const d = state.drawer;
  if (!d) return;
  try {
    const msgs = await api(
      `/api/admin/users/${encodeURIComponent(d.userId)}/messages?limit=${DRAWER_PAGE}&offset=${d.offset}`
    );
    if (!msgs.messages.length && d.offset === 0) {
      body.insertAdjacentHTML(
        "beforeend",
        `<div class="empty">This user hasn't sent any messages yet</div>`
      );
      return;
    }
    body.insertAdjacentHTML(
      "beforeend",
      msgs.messages
        .map(
          (m) => `
        <div class="msg-block">
          <div class="msg-block-head">
            <span class="role-chip ${esc(m.role)}">${esc(m.role)}</span>
            ${m.sessionTitle ? `<span class="msg-session">${esc(m.sessionTitle)}</span>` : ""}
            <span style="margin-left:auto" class="feed-time">${fmtTime(m.createdAt)}</span>
          </div>
          <div class="msg-bubble ${esc(m.role)}">${esc(m.content)}</div>
          <div class="msg-meta">${m.attachments?.length ? `📎 ${m.attachments.map((a) => esc(a.name)).join(", ")}` : ""}</div>
        </div>`
        )
        .join("")
    );
    d.offset += msgs.messages.length;
    d.loaded += msgs.messages.length;
    const more = body.querySelector("#drawer-more");
    more?.remove();
    if (msgs.messages.length === DRAWER_PAGE) {
      const btn = document.createElement("button");
      btn.id = "drawer-more";
      btn.className = "text-link";
      btn.style.cssText = "display:block;margin:0.6rem auto;padding:0.5rem 1rem;border:1px solid var(--border);border-radius:0.6rem;background:var(--bg-raised)";
      btn.textContent = `Load older messages (${d.loaded} shown)`;
      btn.addEventListener("click", drawerLoadMore);
      body.appendChild(btn);
    }
  } catch (err) {
    toast(err.message);
  }
}

function closeDrawer() {
  $("overlay").hidden = true;
  document.body.style.overflow = "";
}

/* ---------------- Events & boot ---------------- */
function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view))
  );
  $("logout").addEventListener("click", async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin-login.html";
  });
  $("refresh-stats").addEventListener("click", loadOverview);
  $("refresh-feed").addEventListener("click", () =>
    loadFeedInto($("feed-list"), state.feed.limit)
  );
  $("goto-feed").addEventListener("click", () => setView("feed"));
  $("drawer-close").addEventListener("click", closeDrawer);
  $("overlay").addEventListener("click", (e) => {
    if (e.target === $("overlay")) closeDrawer();
  });

  let usersTimer;
  $("users-search").addEventListener("input", (e) => {
    clearTimeout(usersTimer);
    usersTimer = setTimeout(() => {
      state.users.q = e.target.value.trim();
      state.users.offset = 0;
      loadUsers();
    }, 300);
  });

  let feedTimer;
  $("feed-search").addEventListener("input", (e) => {
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => {
      state.feed.q = e.target.value.trim();
      loadFeedInto($("feed-list"), state.feed.limit);
    }, 300);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
}

(async () => {
  bindEvents();
  const ok = await gate();
  if (!ok) return;
  loadOverview();
  // Keep the Overview's "live" feel: refresh stats every 20s when on overview.
  setInterval(() => {
    if (state.view === "overview") loadOverview();
  }, 20000);
})();
