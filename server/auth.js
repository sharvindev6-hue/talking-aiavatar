import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { query } from "./db.js";

export const SESSION_COOKIE = "avatar_session";
const SESSION_DAYS = 30;

/** Hash a password with a random salt. Stored as "salt:hash" hex. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/** Constant-time password verification against a stored "salt:hash" value. */
export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Sessions are stored as sha256 hashes so a leaked DB never exposes tokens. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a session row and return the raw token to put in the cookie. */
export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), userId, expiresAt.toISOString()]
  );
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  await query("DELETE FROM sessions WHERE token = $1", [hashToken(token)]);
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Express middleware. Resolves the current user from the session cookie and
 * attaches `req.user` = { id, email, created_at }.
 */
// Periodically purge expired sessions so the table never grows unboundedly.
setInterval(async () => {
  try {
    await query("DELETE FROM sessions WHERE expires_at <= now()");
  } catch {
    /* DB not configured — nothing to purge */
  }
}, 60 * 60 * 1000).unref();

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const { rows } = await query(
      `SELECT u.id, u.email, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );

    if (!rows[0]) {
      // Tidy up the expired/invalid row so stale sessions don't accumulate.
      await query("DELETE FROM sessions WHERE token = $1", [hashToken(token)]).catch(
        () => {}
      );
      res.status(401).json({ error: "Session expired or invalid" });
      return;
    }

    req.user = rows[0];
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}
