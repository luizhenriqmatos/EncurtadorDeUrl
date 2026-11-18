import { DAY_MS } from "./links.js";
import { visitorHash } from "./security.js";

export const PERIODS = ["7d", "30d", "all"];
const MAX_SERIES_DAYS = 365;

// Bots e ferramentas de preview não contam como clique.
const BOT_PATTERN = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python-requests|headless/i;

const dayKey = (time) => new Date(time).toISOString().slice(0, 10);
const startOfDayUtc = (time) => Date.parse(`${dayKey(time)}T00:00:00Z`);

function cleanLabel(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 60);
}

function sourceOf({ utmSource, referer }) {
  const fromUtm = cleanLabel(utmSource);
  if (fromUtm) return fromUtm;
  try {
    const host = cleanLabel(new URL(referer).hostname.replace(/^www\./, ""));
    if (host) return host;
  } catch {
    // sem referer válido
  }
  return "Direto";
}

export function deviceOf(userAgent) {
  if (/ipad|tablet/i.test(userAgent)) return "Tablet";
  if (/mobi|android|iphone/i.test(userAgent)) return "Celular";
  return "Computador";
}

export function browserOf(userAgent) {
  const rules = [
    ["Edge", /edg(e|a|ios)?\//i],
    ["Opera", /opr\/|opera/i],
    ["Firefox", /firefox|fxios/i],
    ["Chrome", /chrome|crios/i],
    ["Safari", /safari/i],
  ];
  return rules.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "Outros";
}

export function countryOf(headers) {
  const raw = headers["cf-ipcountry"] ?? headers["x-vercel-ip-country"] ?? headers["x-country-code"];
  return typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

// Janela de período. "all" não tem limite inferior; a série diária é limitada depois.
export function periodWindow(period = "30d", now = Date.now()) {
  if (period === "all") return { key: "all", days: null, since: 0 };
  const days = period === "7d" ? 7 : 30;
  return { key: days === 7 ? "7d" : "30d", days, since: startOfDayUtc(now) - (days - 1) * DAY_MS };
}

export function recordClick(db, link, { secret, utmSource, referer, userAgent = "", ip = "", country = null, now = Date.now() }) {
  if (BOT_PATTERN.test(userAgent)) return false;
  db.prepare(
    `INSERT INTO clicks (link_id, clicked_at, source, device, browser, country, visitor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    link.id,
    now,
    sourceOf({ utmSource, referer }),
    deviceOf(userAgent),
    browserOf(userAgent),
    country,
    visitorHash(secret, dayKey(now), ip, userAgent),
  );
  return true;
}

// linkId null = todos os links (visão do admin).
export function linkStats(db, linkId, { now = Date.now(), period = "30d" } = {}) {
  const scope = linkId == null ? { sql: "1 = 1", params: [] } : { sql: "link_id = ?", params: [linkId] };
  const win = periodWindow(period, now);
  const inWindow = { sql: `${scope.sql} AND clicked_at >= ?`, params: [...scope.params, win.since] };

  const totals = db
    .prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT visitor) AS uniqueVisitors FROM clicks WHERE ${inWindow.sql}`)
    .get(...inWindow.params);
  const allTime = Number(db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE ${scope.sql}`).get(...scope.params).n);

  let days = win.days;
  if (!days) {
    const first = db.prepare(`SELECT MIN(clicked_at) AS m FROM clicks WHERE ${scope.sql}`).get(...scope.params).m;
    days = first == null
      ? 1
      : Math.min(MAX_SERIES_DAYS, Math.floor((startOfDayUtc(now) - startOfDayUtc(Number(first))) / DAY_MS) + 1);
  }
  const seriesStart = startOfDayUtc(now) - (days - 1) * DAY_MS;
  const series = { sql: `${scope.sql} AND clicked_at >= ?`, params: [...scope.params, seriesStart] };
  const dayRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', clicked_at / 1000.0, 'unixepoch') AS day, COUNT(*) AS clicks
       FROM clicks WHERE ${series.sql} GROUP BY day`,
    )
    .all(...series.params);
  const perDay = new Map(dayRows.map((row) => [row.day, Number(row.clicks)]));
  const byDay = Array.from({ length: days }, (_, index) => {
    const date = dayKey(seriesStart + index * DAY_MS);
    return { date, clicks: perDay.get(date) ?? 0 };
  });

  const groupBy = (expression, limit = 8) =>
    db
      .prepare(
        `SELECT ${expression} AS label, COUNT(*) AS clicks
         FROM clicks WHERE ${inWindow.sql}
         GROUP BY label ORDER BY clicks DESC, label ASC LIMIT ?`,
      )
      .all(...inWindow.params, limit)
      .map((row) => ({ label: String(row.label), clicks: Number(row.clicks) }));

  const topDays = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', clicked_at / 1000.0, 'unixepoch') AS date, COUNT(*) AS clicks
       FROM clicks WHERE ${inWindow.sql}
       GROUP BY date ORDER BY clicks DESC, date DESC LIMIT 5`,
    )
    .all(...inWindow.params)
    .map((row) => ({ date: row.date, clicks: Number(row.clicks) }));

  const recent = db
    .prepare(
      `SELECT clicked_at, source, device, browser, country
       FROM clicks WHERE ${inWindow.sql} ORDER BY clicked_at DESC LIMIT 20`,
    )
    .all(...inWindow.params)
    .map((row) => ({
      at: Number(row.clicked_at),
      source: row.source,
      device: row.device,
      browser: row.browser,
      country: row.country ?? "Desconhecido",
    }));

  return {
    period: win.key,
    totals: {
      total: Number(totals.total),
      uniqueVisitors: Number(totals.uniqueVisitors),
      allTime,
    },
    byDay,
    sources: groupBy("source"),
    devices: groupBy("device"),
    browsers: groupBy("browser"),
    countries: groupBy("COALESCE(country, 'Desconhecido')"),
    topDays,
    recent,
  };
}

// Agregado para exportação: data, país, dispositivo, navegador, origem e contagem. Sem IP nem visitante.
export function exportRows(db, linkId, { period = "30d", now = Date.now() } = {}) {
  const win = periodWindow(period, now);
  return db
    .prepare(
      `SELECT strftime('%Y-%m-%d', clicked_at / 1000.0, 'unixepoch') AS data,
              COALESCE(country, 'Desconhecido') AS pais,
              device AS dispositivo,
              browser AS navegador,
              source AS origem,
              COUNT(*) AS cliques
       FROM clicks
       WHERE link_id = ? AND clicked_at >= ?
       GROUP BY data, pais, dispositivo, navegador, origem
       ORDER BY data DESC, cliques DESC`,
    )
    .all(linkId, win.since)
    .map((row) => ({ ...row, cliques: Number(row.cliques) }));
}
