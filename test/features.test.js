import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, call, cookieOf } from "./helpers.js";

const ctxs = [];
after(() => Promise.all(ctxs.map((ctx) => ctx.close())));

async function register(ctx, email, extra = {}) {
  const res = await call(ctx.base, "/api/auth/register", {
    method: "POST",
    body: { email, password: "senha-forte-1", ...extra },
  });
  return { res, cookie: cookieOf(res), user: res.json?.user };
}

async function createLink(ctx, cookie, body) {
  return call(ctx.base, "/api/links", { method: "POST", cookie, body });
}

// ---------- Segurança e anti-abuso ----------

test("honeypot preenchido é rejeitado sem criar conta", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const res = await register(ctx, "bot@exemplo.com", { website: "http://spam" });
  assert.equal(res.res.status, 400);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
});

test("modo convite exige INVITE_CODE no cadastro", async () => {
  const ctx = await startApp({ inviteCode: "convite-123" });
  ctxs.push(ctx);

  const config = await call(ctx.base, "/api/auth/me");
  assert.equal(config.json.config.inviteRequired, true);

  const without = await register(ctx, "a@exemplo.com");
  assert.equal(without.res.status, 403);

  const wrong = await register(ctx, "a@exemplo.com", { inviteCode: "errado" });
  assert.equal(wrong.res.status, 403);

  const ok = await register(ctx, "a@exemplo.com", { inviteCode: "convite-123" });
  assert.equal(ok.res.status, 201);
});

test("login é limitado a 5 tentativas por 15 min e responde 429 com Retry-After", async () => {
  const ctx = await startApp({ limits: { auth: { limit: 5, windowMs: 15 * 60_000 } } });
  ctxs.push(ctx);
  for (let i = 0; i < 5; i += 1) {
    const res = await call(ctx.base, "/api/auth/login", {
      method: "POST",
      body: { email: "x@exemplo.com", password: "errada-errada" },
    });
    assert.equal(res.status, 401);
  }
  const blocked = await call(ctx.base, "/api/auth/login", {
    method: "POST",
    body: { email: "x@exemplo.com", password: "errada-errada" },
  });
  assert.equal(blocked.status, 429);
  const retry = Number(blocked.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 900, `Retry-After inválido: ${retry}`);
});

test("criação de link é limitada por usuário", async () => {
  const ctx = await startApp({ limits: { createUser: { limit: 3, windowMs: 60_000 } } });
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  for (let i = 0; i < 3; i += 1) {
    const res = await createLink(ctx, cookie, { url: `https://exemplo.com/p${i}` });
    assert.equal(res.status, 201);
  }
  const blocked = await createLink(ctx, cookie, { url: "https://exemplo.com/p9" });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
});

test("URLs para redes privadas, loopback e metadados são bloqueadas", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const blocked = [
    "http://127.0.0.1/admin",
    "http://localhost:3000",
    "http://192.168.0.10",
    "http://10.1.2.3",
    "http://172.20.0.5",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://0x7f.1",
    "http://intranet/",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
    "https://usuario:senha@exemplo.com",
  ];
  for (const url of blocked) {
    const res = await createLink(ctx, cookie, { url });
    assert.equal(res.status, 400, `deveria bloquear ${url}`);
  }
});

test("não encurta o próprio domínio (loop)", async () => {
  const ctx = await startApp({ publicBaseUrl: "https://enc.exemplo.com" });
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const res = await createLink(ctx, cookie, { url: "https://enc.exemplo.com/abc1234" });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /próprio encurtador/);
});

// ---------- Slug personalizado ----------

test("slug personalizado: válido, reservado, curto, duplicado", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");

  const ok = await createLink(ctx, cookie, { url: "https://exemplo.com", alias: "minha-campanha" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.link.code, "minha-campanha");

  const redirect = await call(ctx.base, "/minha-campanha");
  assert.equal(redirect.status, 302);

  const dup = await createLink(ctx, cookie, { url: "https://exemplo.com", alias: "Minha-Campanha" });
  assert.equal(dup.status, 409);

  for (const alias of ["admin", "api", "login", "dashboard", "public"]) {
    const reserved = await createLink(ctx, cookie, { url: "https://exemplo.com", alias });
    assert.equal(reserved.status, 400, `slug reservado aceito: ${alias}`);
  }

  const short = await createLink(ctx, cookie, { url: "https://exemplo.com", alias: "ab" });
  assert.equal(short.status, 400);

  const symbol = await createLink(ctx, cookie, { url: "https://exemplo.com", alias: "a_b_c" });
  assert.equal(symbol.status, 400);
});

// ---------- Senha de proteção ----------

test("link protegido redireciona para página de senha até desbloquear", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const created = await createLink(ctx, cookie, { url: "https://exemplo.com/secreto", password: "segredo1" });
  const { code, id } = created.json.link;
  assert.equal(created.json.link.hasPassword, true);
  assert.equal(created.json.link.targetUrl.includes("segredo1"), false);

  const locked = await call(ctx.base, `/${code}`);
  assert.equal(locked.status, 302);
  assert.equal(locked.headers.get("location"), `/unlock.html?c=${code}`);

  const wrong = await call(ctx.base, `/api/unlock/${code}`, { method: "POST", body: { password: "errada" } });
  assert.equal(wrong.status, 401);

  const right = await call(ctx.base, `/api/unlock/${code}`, { method: "POST", body: { password: "segredo1" } });
  assert.equal(right.status, 200);
  assert.equal(right.json.redirect, `/${code}`);
  const unlockCookie = cookieOf(right);
  assert.match(unlockCookie, new RegExp(`^unlock_${code}=`));

  const open = await call(ctx.base, `/${code}`, { cookie: unlockCookie });
  assert.equal(open.status, 302);
  assert.equal(open.headers.get("location"), "https://exemplo.com/secreto");

  const stats = await call(ctx.base, `/api/links/${id}`, { cookie });
  assert.equal(stats.json.stats.totals.total, 1, "clique só conta após desbloqueio");
});

test("trocar a senha invalida desbloqueios antigos", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const { code, id } = (await createLink(ctx, cookie, { url: "https://exemplo.com", password: "antiga123" })).json.link;
  const right = await call(ctx.base, `/api/unlock/${code}`, { method: "POST", body: { password: "antiga123" } });
  const unlockCookie = cookieOf(right);

  await call(ctx.base, `/api/links/${id}`, { method: "PATCH", cookie, body: { password: "nova-senha" } });
  const res = await call(ctx.base, `/${code}`, { cookie: unlockCookie });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/unlock.html?c=${code}`);
});

test("remover senha libera o link", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const { code, id } = (await createLink(ctx, cookie, { url: "https://exemplo.com", password: "abcd1234" })).json.link;
  const res = await call(ctx.base, `/api/links/${id}`, { method: "PATCH", cookie, body: { password: null } });
  assert.equal(res.json.link.hasPassword, false);
  const open = await call(ctx.base, `/${code}`);
  assert.equal(open.headers.get("location"), "https://exemplo.com/");
});

// ---------- Edição, pausa e exclusão ----------

test("editar URL de destino valida e aplica safety", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const { id, code } = (await createLink(ctx, cookie, { url: "https://exemplo.com/a" })).json.link;

  const ok = await call(ctx.base, `/api/links/${id}`, {
    method: "PATCH",
    cookie,
    body: { targetUrl: "https://exemplo.org/novo" },
  });
  assert.equal(ok.json.link.targetUrl, "https://exemplo.org/novo");

  const bad = await call(ctx.base, `/api/links/${id}`, {
    method: "PATCH",
    cookie,
    body: { targetUrl: "http://127.0.0.1" },
  });
  assert.equal(bad.status, 400);

  const redirect = await call(ctx.base, `/${code}`);
  assert.equal(redirect.headers.get("location"), "https://exemplo.org/novo");
});

// ---------- Exportação ----------

test("exportação CSV e JSON agregados, sem IP nem visitante", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const { id, code } = (await createLink(ctx, cookie, { url: "https://exemplo.com" })).json.link;
  await call(ctx.base, `/${code}?utm_source=email`, { headers: { "x-forwarded-for": "203.0.113.9" } });
  await call(ctx.base, `/${code}?utm_source=email`);

  const csv = await call(ctx.base, `/api/links/${id}/export?format=csv&period=30d`, { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /attachment; filename="link-.*-30d\.csv"/);
  // fetch().text() descarta o BOM UTF-8; o cabeçalho continua sendo a primeira linha.
  assert.match(csv.text, /^(﻿)?data,pais,dispositivo,navegador,origem,cliques\r\n/);
  assert.match(csv.text, /,email,/);
  assert.doesNotMatch(csv.text, /203\.0\.113\.9/);

  const json = await call(ctx.base, `/api/links/${id}/export?format=json&period=all`, { cookie });
  assert.equal(json.json.period, "all");
  assert.equal(json.json.rows.reduce((sum, row) => sum + row.cliques, 0), 2);
  assert.equal(Object.keys(json.json.rows[0]).sort().join(","), "cliques,dispositivo,data,navegador,origem,pais".split(",").sort().join(","));

  const bad = await call(ctx.base, `/api/links/${id}/export?format=xml`, { cookie });
  assert.equal(bad.status, 400);
});

test("período 7d e all alteram a série diária", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const { cookie } = await register(ctx, "ana@exemplo.com");
  const { id, code } = (await createLink(ctx, cookie, { url: "https://exemplo.com" })).json.link;
  await call(ctx.base, `/${code}`);

  const week = await call(ctx.base, `/api/links/${id}?period=7d`, { cookie });
  assert.equal(week.json.stats.period, "7d");
  assert.equal(week.json.stats.byDay.length, 7);

  const all = await call(ctx.base, `/api/links/${id}?period=all`, { cookie });
  assert.equal(all.json.stats.period, "all");
  assert.equal(all.json.stats.totals.allTime, 1);
  assert.ok(all.json.stats.byDay.length >= 1 && all.json.stats.byDay.length <= 365);
});

// ---------- Moderação ----------

test("suspender usuário derruba sessões, bloqueia login e desliga links dele", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const admin = await register(ctx, "admin@exemplo.com");
  const user = await register(ctx, "bia@exemplo.com");
  const { code } = (await createLink(ctx, user.cookie, { url: "https://exemplo.com" })).json.link;

  const ban = await call(ctx.base, `/api/admin/users/${user.user.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { banned: true },
  });
  assert.equal(ban.json.user.banned, true);

  const session = await call(ctx.base, "/api/links", { cookie: user.cookie });
  assert.equal(session.status, 401);

  const login = await call(ctx.base, "/api/auth/login", {
    method: "POST",
    body: { email: "bia@exemplo.com", password: "senha-forte-1" },
  });
  assert.equal(login.status, 403);

  const redirect = await call(ctx.base, `/${code}`);
  assert.equal(redirect.status, 410);

  await call(ctx.base, `/api/admin/users/${user.user.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { banned: false },
  });
  const back = await call(ctx.base, `/${code}`);
  assert.equal(back.status, 302);
});

test("admin não pode suspender nem rebaixar a própria conta", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const admin = await register(ctx, "admin@exemplo.com");
  const self = await call(ctx.base, `/api/admin/users/${admin.user.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { banned: true },
  });
  assert.equal(self.status, 400);
  const demote = await call(ctx.base, `/api/admin/users/${admin.user.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { role: "user" },
  });
  assert.equal(demote.status, 400);
});

test("promover e rebaixar admin", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const admin = await register(ctx, "admin@exemplo.com");
  const user = await register(ctx, "bia@exemplo.com");

  const promote = await call(ctx.base, `/api/admin/users/${user.user.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { role: "admin" },
  });
  assert.equal(promote.json.user.role, "admin");

  const demote = await call(ctx.base, `/api/admin/users/${user.user.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { role: "user" },
  });
  assert.equal(demote.json.user.role, "user");
});

test("kill-switch: admin desativa; dono não consegue reativar até liberação", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const admin = await register(ctx, "admin@exemplo.com");
  const user = await register(ctx, "spam@exemplo.com");
  const { id, code } = (await createLink(ctx, user.cookie, { url: "https://exemplo.com" })).json.link;

  const kill = await call(ctx.base, `/api/admin/links/${id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { kill: true },
  });
  assert.equal(kill.json.link.adminLocked, true);
  assert.equal(kill.json.link.status, "desativado");

  const redirect = await call(ctx.base, `/${code}`);
  assert.equal(redirect.status, 410);
  assert.match(redirect.text, /moderação/);

  const owner = await call(ctx.base, `/api/links/${id}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: { disabled: false },
  });
  assert.equal(owner.status, 403);

  await call(ctx.base, `/api/admin/links/${id}`, { method: "PATCH", cookie: admin.cookie, body: { kill: false } });
  const reopened = await call(ctx.base, `/api/links/${id}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: { disabled: false },
  });
  assert.equal(reopened.status, 200);
});

test("busca de links no admin por código ou destino, com escape de LIKE", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const admin = await register(ctx, "admin@exemplo.com");
  await createLink(ctx, admin.cookie, { url: "https://loja-exemplo.com/oferta" });
  await createLink(ctx, admin.cookie, { url: "https://outra.com/página" });

  const byHost = await call(ctx.base, "/api/admin/links?q=loja-exemplo", { cookie: admin.cookie });
  assert.equal(byHost.json.links.length, 1);

  // "%" e "_" são literais: só casa o link cujo destino tem "%" codificado (p%C3%A1gina).
  const percent = await call(ctx.base, `/api/admin/links?q=${encodeURIComponent("%")}`, { cookie: admin.cookie });
  assert.equal(percent.json.links.length, 1);
  assert.match(percent.json.links[0].targetUrl, /outra\.com/);
  const underscore = await call(ctx.base, `/api/admin/links?q=${encodeURIComponent("_")}`, { cookie: admin.cookie });
  assert.equal(underscore.json.links.length, 0);
});

// ---------- Front e orb ----------

test("tela de senha e front referenciam os estados do orb", async () => {
  const ctx = await startApp();
  ctxs.push(ctx);
  const unlock = await call(ctx.base, "/unlock.js");
  assert.equal(unlock.status, 200);
  assert.match(unlock.text, /listening/);
  assert.match(unlock.text, /shaping/);
  const app = await call(ctx.base, "/app.js");
  for (const state of ["searching", "composing", "solving", "shaping", "listening", "working"]) {
    assert.match(app.text, new RegExp(state), `estado ${state} ausente`);
  }
});
