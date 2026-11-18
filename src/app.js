import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { HttpError, sendJson, sendText, readJson, parseCookies, clientIp, escapeHtml } from "./http.js";
import { hashPassword, verifyPassword, createSession, userFromToken, destroySession, SESSION_MAX_AGE_S } from "./auth.js";
import { normalizeUrl, parseExpiry, generateCode, linkStatus } from "./links.js";
import { recordClick, linkStats, countryOf } from "./stats.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const SESSION_COOKIE = "sid";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_ROUTE = /^\/api\/links\/(\d+)(\/qr\.svg)?$/;
const CODE_ROUTE = /^\/([A-Za-z0-9]{4,32})$/;

export function createApp({
  db,
  adminEmail = process.env.ADMIN_EMAIL ?? "",
  publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "",
  secureCookies = process.env.NODE_ENV === "production",
} = {}) {
  const now = () => Date.now();
  const userOf = (req) => userFromToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  const requireUser = (req) => {
    const user = userOf(req);
    if (!user) throw new HttpError(401, "Faça login para continuar.");
    return user;
  };

  const requireAdmin = (req) => {
    const user = requireUser(req);
    if (user.role !== "admin") throw new HttpError(403, "Acesso restrito ao administrador.");
    return user;
  };

  const findLinkOr404 = (id, user) => {
    const link = db.prepare("SELECT * FROM links WHERE id = ?").get(Number(id));
    if (!link || (link.user_id !== user.id && user.role !== "admin")) {
      throw new HttpError(404, "Link não encontrado.");
    }
    return link;
  };

  const uniqueCode = () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateCode();
      if (!db.prepare("SELECT 1 FROM links WHERE code = ?").get(code)) return code;
    }
    throw new HttpError(500, "Não foi possível gerar um código. Tente novamente.");
  };

  const cookieFor = (token, maxAge) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;

  const startSession = (res, user, status = 200) => {
    const { token } = createSession(db, user.id);
    sendJson(
      res,
      status,
      { user: { id: user.id, email: user.email, role: user.role } },
      { "Set-Cookie": cookieFor(token, SESSION_MAX_AGE_S) },
    );
  };

  const serializeLink = (link, base, totalClicks = 0, owner) => ({
    id: link.id,
    code: link.code,
    shortUrl: `${base}/${link.code}`,
    targetUrl: link.target_url,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
    disabled: Boolean(link.disabled),
    status: linkStatus(link, now()),
    totalClicks: Number(totalClicks),
    ...(owner ? { owner } : {}),
  });

  async function handleApi(req, res, url, base) {
    const { pathname } = url;
    const method = req.method;

    // Auth
    if (method === "POST" && pathname === "/api/auth/register") {
      const body = await readJson(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, "E-mail inválido.");
      if (password.length < 8 || password.length > 1024) {
        throw new HttpError(400, "A senha precisa ter entre 8 e 1024 caracteres.");
      }
      if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
        throw new HttpError(409, "Já existe uma conta com este e-mail.");
      }
      const hasUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
      const role = !hasUsers || email === adminEmail.toLowerCase() ? "admin" : "user";
      const info = db
        .prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
        .run(email, hashPassword(password), role, now());
      return startSession(res, { id: Number(info.lastInsertRowid), email, role }, 201);
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      const body = await readJson(req);
      const row = db
        .prepare("SELECT id, email, role, password_hash FROM users WHERE email = ?")
        .get(String(body.email ?? "").trim().toLowerCase());
      if (!row || !verifyPassword(String(body.password ?? ""), row.password_hash)) {
        throw new HttpError(401, "E-mail ou senha incorretos.");
      }
      return startSession(res, row);
    }

    if (method === "POST" && pathname === "/api/auth/logout") {
      destroySession(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookieFor("", 0) });
    }

    if (method === "GET" && pathname === "/api/auth/me") {
      return sendJson(res, 200, { user: userOf(req) ?? null });
    }

    // Links do usuário
    if (pathname === "/api/links" && method === "POST") {
      const user = requireUser(req);
      const body = await readJson(req);
      const targetUrl = normalizeUrl(body.url);
      const expiresAt = parseExpiry(body.expires);
      const code = uniqueCode();
      const info = db
        .prepare("INSERT INTO links (user_id, code, target_url, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(user.id, code, targetUrl, now(), expiresAt);
      const link = db.prepare("SELECT * FROM links WHERE id = ?").get(Number(info.lastInsertRowid));
      const qr = await QRCode.toDataURL(`${base}/${code}`, { margin: 1, width: 320, errorCorrectionLevel: "M" });
      return sendJson(res, 201, { link: serializeLink(link, base, 0), qr });
    }

    if (pathname === "/api/links" && method === "GET") {
      const user = requireUser(req);
      const rows = db
        .prepare(
          `SELECT l.*, (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id) AS total_clicks
           FROM links l WHERE l.user_id = ? ORDER BY l.created_at DESC`,
        )
        .all(user.id);
      return sendJson(res, 200, { links: rows.map((row) => serializeLink(row, base, row.total_clicks)) });
    }

    const linkMatch = pathname.match(LINK_ROUTE);
    if (linkMatch) {
      const user = requireUser(req);
      const link = findLinkOr404(linkMatch[1], user);
      const isQr = Boolean(linkMatch[2]);

      if (isQr && method === "GET") {
        const svg = await QRCode.toString(`${base}/${link.code}`, { type: "svg", margin: 1 });
        return sendText(res, 200, svg, "image/svg+xml; charset=utf-8");
      }

      if (!isQr && method === "GET") {
        const stats = linkStats(db, link.id, { now: now() });
        return sendJson(res, 200, { link: serializeLink(link, base, stats.totals.total), stats });
      }

      if (!isQr && method === "PATCH") {
        const body = await readJson(req);
        const disabled = typeof body.disabled === "boolean" ? (body.disabled ? 1 : 0) : link.disabled;
        const expiresAt = "expires" in body ? parseExpiry(body.expires) : link.expires_at;
        db.prepare("UPDATE links SET disabled = ?, expires_at = ? WHERE id = ?").run(disabled, expiresAt, link.id);
        const updated = db.prepare("SELECT * FROM links WHERE id = ?").get(link.id);
        const total = db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE link_id = ?").get(link.id).n;
        return sendJson(res, 200, { link: serializeLink(updated, base, total) });
      }

      if (!isQr && method === "DELETE") {
        db.prepare("DELETE FROM links WHERE id = ?").run(link.id);
        res.writeHead(204).end();
        return;
      }
    }

    // Admin
    if (method === "GET" && pathname === "/api/admin/overview") {
      requireAdmin(req);
      const t = now();
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS links,
                  COALESCE(SUM(CASE WHEN disabled = 0 AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END), 0) AS active
           FROM links`,
        )
        .get(t);
      const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
      const stats = linkStats(db, null, { now: t });
      const topLinks = db
        .prepare(
          `SELECT l.*, u.email AS owner,
                  (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id) AS total_clicks
           FROM links l JOIN users u ON u.id = l.user_id
           ORDER BY total_clicks DESC, l.created_at DESC LIMIT 10`,
        )
        .all();
      const users = db
        .prepare(
          `SELECT u.id, u.email, u.role, u.created_at,
                  (SELECT COUNT(*) FROM links l WHERE l.user_id = u.id) AS links
           FROM users u ORDER BY u.created_at DESC LIMIT 50`,
        )
        .all();
      return sendJson(res, 200, {
        totals: {
          links: Number(counts.links),
          activeLinks: Number(counts.active),
          users: Number(userCount),
          clicks: stats.totals.total,
          last7Days: stats.totals.last7Days,
          uniqueVisitors: stats.totals.uniqueVisitors,
        },
        byDay: stats.byDay,
        sources: stats.sources,
        devices: stats.devices,
        topLinks: topLinks.map((row) => serializeLink(row, base, row.total_clicks, row.owner)),
        users: users.map((u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.created_at, links: Number(u.links) })),
      });
    }

    throw new HttpError(404, "Rota não encontrada.");
  }

  async function serveStatic(res, pathname) {
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, relative));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return false;
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=300",
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  function sendPage(res, status, title, message) {
    const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;background:#0a0c10;color:#e8ebf2;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="text-align:center;padding:24px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<a href="/" style="color:#7cf5c4">Ir para o encurtador</a></main></body></html>`;
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }

  function redirectTo(req, res, code, url) {
    const link = db.prepare("SELECT * FROM links WHERE code = ?").get(code);
    if (!link) return sendPage(res, 404, "Link não encontrado", "Este link curto não existe.");

    const status = linkStatus(link, now());
    if (status === "expirado") return sendPage(res, 410, "Link expirado", "Este link passou da data de expiração.");
    if (status === "desativado") return sendPage(res, 410, "Link desativado", "O dono desativou este link.");

    try {
      recordClick(db, link, {
        utmSource: url.searchParams.get("utm_source"),
        referer: req.headers.referer,
        userAgent: req.headers["user-agent"] ?? "",
        ip: clientIp(req),
        country: countryOf(req.headers),
        now: now(),
      });
    } catch (error) {
      console.error("Clique não registrado:", error.message);
    }

    res.writeHead(302, { Location: link.target_url, "Cache-Control": "no-store" });
    res.end();
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const base = (publicBaseUrl || `http://${req.headers.host}`).replace(/\/+$/, "");

      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, base);

      if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;

      const codeMatch = url.pathname.match(CODE_ROUTE);
      if (codeMatch && req.method === "GET") return redirectTo(req, res, codeMatch[1], url);

      return sendPage(res, 404, "Página não encontrada", "O endereço que você acessou não existe.");
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      console.error(error);
      return sendJson(res, 500, { error: "Erro interno do servidor." });
    }
  };
}
