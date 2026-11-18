import http from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

// Limites altos nos testes para não interferir nos fluxos. Testes de limite usam valores próprios.
export const RELAXED_LIMITS = {
  auth: { limit: 1000, windowMs: 60_000 },
  unlock: { limit: 1000, windowMs: 60_000 },
  createAnon: { limit: 1000, windowMs: 60_000 },
  createUser: { limit: 1000, windowMs: 60_000 },
};

export async function startApp({ db = openDb(":memory:"), limits = {}, ...options } = {}) {
  const handle = createApp({
    db,
    adminEmail: "",
    publicBaseUrl: "",
    secret: "segredo-de-teste",
    limits: { ...RELAXED_LIMITS, ...limits },
    ...options,
  });
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () =>
    new Promise((resolve) => {
      handle.close();
      server.close(resolve);
    });
  return { db, base, close };
}

export async function call(base, path, { method = "GET", body, cookie, userAgent = USER_AGENT, headers = {} } = {}) {
  const requestHeaders = { "user-agent": userAgent, ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  const init = { method, redirect: "manual", headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + path, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // não é JSON
  }
  return { status: response.status, headers: response.headers, json, text };
}

export const cookieOf = (response) => response.headers.get("set-cookie")?.split(";")[0];
