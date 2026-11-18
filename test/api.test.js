import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

let server;
let base;
let db;
let adminCookie;
let userCookie;
let linkId;
let code;

before(async () => {
  db = openDb(":memory:");
  server = http.createServer(createApp({ db, adminEmail: "", publicBaseUrl: "" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, { method = "GET", body, cookie, userAgent = USER_AGENT } = {}) {
  const headers = { "user-agent": userAgent };
  if (cookie) headers.cookie = cookie;
  const init = { method, redirect: "manual", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + path, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // resposta não é JSON
  }
  return { status: response.status, headers: response.headers, json, text };
}

const sessionOf = (response) => response.headers.get("set-cookie")?.split(";")[0];

test("primeiro cadastro vira administrador e abre sessão", async () => {
  const res = await call("/api/auth/register", {
    method: "POST",
    body: { email: "ana@exemplo.com", password: "senha-forte-1" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, "admin");
  adminCookie = sessionOf(res);
  assert.match(adminCookie, /^sid=/);
});

test("segundo cadastro é usuário comum; duplicado e senha fraca são recusados", async () => {
  const res = await call("/api/auth/register", {
    method: "POST",
    body: { email: "bia@exemplo.com", password: "outra-senha-2" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, "user");
  userCookie = sessionOf(res);

  const dup = await call("/api/auth/register", {
    method: "POST",
    body: { email: "bia@exemplo.com", password: "outra-senha-2" },
  });
  assert.equal(dup.status, 409);

  const weak = await call("/api/auth/register", {
    method: "POST",
    body: { email: "carl@exemplo.com", password: "curta" },
  });
  assert.equal(weak.status, 400);
});

test("login recusa senha errada", async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: { email: "ana@exemplo.com", password: "errada-errada" },
  });
  assert.equal(res.status, 401);
});

test("rotas de link exigem sessão", async () => {
  const res = await call("/api/links");
  assert.equal(res.status, 401);
});

test("criar link retorna URL curta e QR Code", async () => {
  const res = await call("/api/links", {
    method: "POST",
    cookie: adminCookie,
    body: { url: "exemplo.com/artigo-muito-longo?utm_source=newsletter&x=1", expires: "7d" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.link.targetUrl, "https://exemplo.com/artigo-muito-longo?utm_source=newsletter&x=1");
  assert.equal(res.json.link.status, "ativo");
  assert.ok(res.json.link.expiresAt > Date.now());
  assert.match(res.json.qr, /^data:image\/png;base64,/);
  linkId = res.json.link.id;
  code = res.json.link.code;
  assert.match(res.json.link.shortUrl, new RegExp(`/${code}$`));
});

test("recusa URLs perigosas e expiração no passado", async () => {
  const js = await call("/api/links", {
    method: "POST",
    cookie: adminCookie,
    body: { url: "javascript:alert(1)" },
  });
  assert.equal(js.status, 400);

  const past = await call("/api/links", {
    method: "POST",
    cookie: adminCookie,
    body: { url: "https://exemplo.com", expires: "2000-01-01T00:00:00Z" },
  });
  assert.equal(past.status, 400);
});

test("redirecionamento 302 registra clique com origem do utm", async () => {
  const res = await call(`/${code}?utm_source=WhatsApp`, { userAgent: USER_AGENT });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://exemplo.com/artigo-muito-longo?utm_source=newsletter&x=1");

  const stats = await call(`/api/links/${linkId}`, { cookie: adminCookie });
  assert.equal(stats.status, 200);
  assert.equal(stats.json.stats.totals.total, 1);
  assert.equal(stats.json.stats.sources[0].label, "whatsapp");
  assert.equal(stats.json.stats.devices[0].label, "Computador");
  assert.equal(stats.json.stats.browsers[0].label, "Chrome");
});

test("bots não contam como clique", async () => {
  const res = await call(`/${code}`, { userAgent: "Googlebot/2.1" });
  assert.equal(res.status, 302);
  const stats = await call(`/api/links/${linkId}`, { cookie: adminCookie });
  assert.equal(stats.json.stats.totals.total, 1);
});

test("série diária tem 30 pontos e soma bate com o total", async () => {
  const res = await call(`/api/links/${linkId}`, { cookie: adminCookie });
  const { byDay, totals } = res.json.stats;
  assert.equal(byDay.length, 30);
  assert.equal(byDay.reduce((sum, day) => sum + day.clicks, 0), totals.total);
  assert.equal(res.json.stats.topDays[0].clicks, 1);
});

test("QR Code SVG só para o dono", async () => {
  const own = await call(`/api/links/${linkId}/qr.svg`, { cookie: adminCookie });
  assert.equal(own.status, 200);
  assert.match(own.text, /<svg/);

  const other = await call(`/api/links/${linkId}/qr.svg`, { cookie: userCookie });
  assert.equal(other.status, 404);
});

test("link de outro usuário fica invisível e intocável", async () => {
  const list = await call("/api/links", { cookie: userCookie });
  assert.equal(list.json.links.length, 0);

  const detail = await call(`/api/links/${linkId}`, { cookie: userCookie });
  assert.equal(detail.status, 404);

  const remove = await call(`/api/links/${linkId}`, { method: "DELETE", cookie: userCookie });
  assert.equal(remove.status, 404);
});

test("desativar retorna 410 e reativar volta a redirecionar", async () => {
  const off = await call(`/api/links/${linkId}`, { method: "PATCH", cookie: adminCookie, body: { disabled: true } });
  assert.equal(off.json.link.status, "desativado");

  const gone = await call(`/${code}`);
  assert.equal(gone.status, 410);

  const on = await call(`/api/links/${linkId}`, { method: "PATCH", cookie: adminCookie, body: { disabled: false } });
  assert.equal(on.json.link.status, "ativo");

  const back = await call(`/${code}`);
  assert.equal(back.status, 302);
});

test("link expirado retorna 410 e aparece como expirado", async () => {
  db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, linkId);

  const res = await call(`/${code}`);
  assert.equal(res.status, 410);
  assert.match(res.text, /expirado/i);

  const detail = await call(`/api/links/${linkId}`, { cookie: adminCookie });
  assert.equal(detail.json.link.status, "expirado");

  const extended = await call(`/api/links/${linkId}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { expires: "30d" },
  });
  assert.equal(extended.json.link.status, "ativo");
});

test("código inexistente retorna 404", async () => {
  const res = await call("/naoexiste");
  assert.equal(res.status, 404);
});

test("painel admin: só admin acessa e enxerga todos os links", async () => {
  const denied = await call("/api/admin/overview", { cookie: userCookie });
  assert.equal(denied.status, 403);

  const res = await call("/api/admin/overview", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.totals.links, 1);
  assert.equal(res.json.totals.users, 2);
  assert.equal(res.json.topLinks[0].owner, "ana@exemplo.com");
  assert.equal(res.json.byDay.length, 30);
});

test("exclusão do próprio link remove redirecionamento", async () => {
  const del = await call(`/api/links/${linkId}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(del.status, 204);
  const res = await call(`/${code}`);
  assert.equal(res.status, 404);
});

test("logout invalida a sessão", async () => {
  await call("/api/auth/logout", { method: "POST", body: {}, cookie: userCookie });
  const res = await call("/api/links", { cookie: userCookie });
  assert.equal(res.status, 401);
});

test("front estático é servido", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /data-thinking-orb/);
  const orbs = await call("/thinking-orbs.js");
  assert.equal(orbs.status, 200);
  assert.match(orbs.text, /MIT License/);
});
