import crypto from "node:crypto";

export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;
const KEY_LENGTH = 64;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, now + SESSION_MAX_AGE_S * 1000);
  return { token };
}

export function userFromToken(db, token, now = Date.now()) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.email, u.role FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), now) ?? null
  );
}

export function destroySession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}
