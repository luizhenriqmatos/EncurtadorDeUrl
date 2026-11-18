import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRateLimiter } from "../src/ratelimit.js";
import { isPrivateHostname, assertSafeTarget, safeEqual, hashIp, visitorHash } from "../src/security.js";
import { csvCell, toCsv } from "../src/export.js";
import { openDb, SCHEMA_VERSION } from "../src/db.js";
import { generateCode, validateAlias, applyUtm, linkStatus, parseExpiry } from "../src/links.js";

test("rate limiter: janela deslizante libera após expirar", () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.hit("k", 0).allowed, true);
  assert.equal(limiter.hit("k", 100).allowed, true);
  const third = limiter.hit("k", 200);
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfter, 1);
  assert.equal(limiter.hit("k", 1001).allowed, true, "primeira tentativa saiu da janela");
  assert.equal(limiter.hit("outra", 200).allowed, true, "chaves são independentes");
  limiter.close();
});

test("rate limiter: limpeza remove chaves inativas", () => {
  const limiter = createRateLimiter({ limit: 5, windowMs: 1000 });
  limiter.hit("a", 0);
  limiter.hit("b", 0);
  limiter.sweep(5000);
  assert.equal(limiter.size(), 0);
  limiter.close();
});

test("hosts privados e especiais são detectados", () => {
  for (const host of [
    "localhost", "api.localhost", "127.0.0.1", "10.0.0.1", "172.31.255.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "[::1]", "[fd00::1]", "[fe80::1]",
    "[::ffff:127.0.0.1]", "intranet", "servidor.internal",
  ]) {
    assert.equal(isPrivateHostname(host), true, `deveria ser privado: ${host}`);
  }
  for (const host of ["exemplo.com", "8.8.8.8", "172.32.0.1", "[2001:4860:4860::8888]"]) {
    assert.equal(isPrivateHostname(host), false, `não deveria ser privado: ${host}`);
  }
});

test("assertSafeTarget aceita http/https públicos e recusa o resto", () => {
  assert.equal(assertSafeTarget("https://exemplo.com/a?b=1"), "https://exemplo.com/a?b=1");
  assert.throws(() => assertSafeTarget("ftp://exemplo.com"), /http ou https/);
  assert.throws(() => assertSafeTarget("https://exemplo.com", new Set(["exemplo.com"])), /próprio/);
});

test("comparação de segredos é em tempo constante e sem falsos positivos", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("IP é hasheado e visitante muda de um dia para o outro", () => {
  const ipHash = hashIp("s", "203.0.113.9");
  assert.doesNotMatch(ipHash, /203\.0\.113\.9/);
  assert.equal(ipHash.length, 32);
  const day1 = visitorHash("s", "2026-11-01", "203.0.113.9", "ua");
  const day2 = visitorHash("s", "2026-11-02", "203.0.113.9", "ua");
  assert.notEqual(day1, day2);
  assert.equal(day1, visitorHash("s", "2026-11-01", "203.0.113.9", "ua"));
});

test("CSV neutraliza fórmulas e escapa separadores", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")").startsWith("\"'=") || csvCell("=1+1").startsWith("'="), true);
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("a,b"), "\"a,b\"");
  assert.equal(csvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
  const out = toCsv(["a", "b"], [{ a: "x", b: 2 }]);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.match(out, /a,b\r\nx,2\r\n$/);
});

test("alias, utm, expiração e status", () => {
  assert.equal(validateAlias("promo-2026"), "promo-2026");
  assert.throws(() => validateAlias("api"));
  assert.equal(applyUtm("https://a.com/?x=1", { source: "fb", medium: "", campaign: "c d" }),
    "https://a.com/?x=1&utm_source=fb&utm_campaign=c+d");
  assert.throws(() => applyUtm("https://a.com", { source: "<script>" }), /Valor inválido/);
  assert.equal(applyUtm("https://a.com", null), "https://a.com/");
  assert.equal(parseExpiry("never"), null);
  assert.equal(linkStatus({ disabled: 1, expires_at: null }), "desativado");
  assert.equal(linkStatus({ disabled: 0, expires_at: 10 }, 20), "expirado");
  assert.equal(generateCode().length, 7);
});

test("migração: banco v1 sem colunas novas é atualizado sem perder dados", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enc-mig-"));
  const file = path.join(dir, "old.db");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE links (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE, target_url TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at INTEGER NOT NULL, source TEXT NOT NULL, device TEXT NOT NULL, browser TEXT NOT NULL, country TEXT, visitor TEXT NOT NULL);
    INSERT INTO users (email, password_hash, role, created_at) VALUES ('a@a.com', 'x', 'admin', 1);
    INSERT INTO links (user_id, code, target_url, created_at) VALUES (1, 'abc1234', 'https://exemplo.com', 1);
  `);
  legacy.close();

  const db = openDb(file);
  assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), SCHEMA_VERSION);
  const link = db.prepare("SELECT code, target_url, password_hash, admin_locked FROM links").get();
  assert.equal(link.code, "abc1234");
  assert.equal(link.password_hash, null);
  assert.equal(Number(link.admin_locked), 0);
  assert.equal(Number(db.prepare("SELECT banned FROM users").get().banned), 0);

  // Reabrir não reaplica migrações nem falha.
  db.close();
  openDb(file).close();
  fs.rmSync(dir, { recursive: true, force: true });
});
