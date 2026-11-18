import { thinkingOrbs } from "/thinking-orbs.js";

const app = document.querySelector("#app");
const nav = document.querySelector("#nav");
const headerOrb = document.querySelector("#header-orb");
const toast = document.querySelector("#toast");
const fmt = new Intl.NumberFormat("pt-BR");

const state = { user: null, authMode: "login" };
let appOrbCleanup = null;

const STATUS_LABEL = { ativo: "Ativo", expirado: "Expirado", desativado: "Desativado" };
const EXPIRY_OPTIONS = [
  ["never", "Sem expiração"],
  ["1d", "1 dia"],
  ["7d", "7 dias"],
  ["30d", "30 dias"],
  ["90d", "90 dias"],
];

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

const dayLabel = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dateTime = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const expiryLabel = (ms) => (ms ? dateTime(ms) : "Sem expiração");
const statusBadge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;

async function api(path, { method = "GET", body } = {}) {
  const options = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Falha na requisição.");
    error.status = response.status;
    throw error;
  }
  return data;
}

// Orb do cabeçalho: o estado reflete o que o sistema está fazendo.
function setOrb(orbState) {
  headerOrb.dataset.orbState = orbState;
  thinkingOrbs(headerOrb);
}

// Troca a tela inteira e recria os orbs dela, liberando os antigos.
function mount(html) {
  appOrbCleanup?.();
  app.innerHTML = html;
  appOrbCleanup = thinkingOrbs(app);
}

function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (toast.hidden = true), 3500);
}

function renderNav() {
  nav.innerHTML = state.user
    ? `<a href="#/">Meus links</a>${state.user.role === "admin" ? '<a href="#/admin">Admin</a>' : ""}
       <span class="muted small">${esc(state.user.email)}</span>
       <button class="link" data-action="logout">Sair</button>`
    : "";
}

// ---------- Autenticação ----------

function renderAuth() {
  const login = state.authMode === "login";
  mount(`
    <section class="auth card">
      <canvas data-thinking-orb data-orb-state="listening" data-orb-size="64" data-orb-theme="dark" aria-label="Aguardando login"></canvas>
      <h1>${login ? "Entrar" : "Criar conta"}</h1>
      <p class="muted">${login ? "Acesse seus links e métricas." : "O primeiro cadastro vira administrador."}</p>
      <form id="auth-form" class="stack">
        <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
        <label>Senha<input name="password" type="password" required minlength="8" autocomplete="${login ? "current-password" : "new-password"}"></label>
        <p class="error" id="auth-error" role="alert"></p>
        <button class="btn primary" type="submit">${login ? "Entrar" : "Criar conta"}</button>
      </form>
      <button class="link" type="button" id="switch-auth">${login ? "Não tem conta? Criar agora" : "Já tenho conta"}</button>
    </section>`);

  document.querySelector("#switch-auth").onclick = () => {
    state.authMode = login ? "register" : "login";
    renderAuth();
  };

  document.querySelector("#auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errorEl = form.querySelector("#auth-error");
    setOrb("composing");
    try {
      const { user } = await api(login ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body: Object.fromEntries(new FormData(form)),
      });
      state.user = user;
      history.replaceState(null, "", "#/");
      await route();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      setOrb("working");
    }
  };
}

// ---------- Painel do usuário ----------

async function renderDashboard() {
  mount(`
    <section class="hero">
      <p class="eyebrow">Encurtador de URL</p>
      <h1>Links curtos com QR Code e métricas de clique.</h1>
      <p class="muted">Cole uma URL grande, escolha quando ela expira e acompanhe quem clica.</p>
    </section>
    <section class="card">
      <form id="shorten" class="shorten">
        <label class="grow">URL de destino
          <input name="url" type="text" inputmode="url" placeholder="https://exemplo.com/uma-url-bem-grande?utm_source=..." required>
        </label>
        <label>Expira em
          <select name="expires">${EXPIRY_OPTIONS.map(([value, label]) => `<option value="${value}"${value === "30d" ? " selected" : ""}>${label}</option>`).join("")}</select>
        </label>
        <button class="btn primary" type="submit">Gerar link</button>
      </form>
      <p class="error" id="shorten-error" role="alert"></p>
      <div id="result"></div>
    </section>
    <section class="card">
      <div class="row between"><h2>Meus links</h2><span class="muted small" id="count"></span></div>
      <div id="links"></div>
    </section>`);

  document.querySelector("#shorten").onsubmit = onShorten;
  await loadLinks();
}

async function onShorten(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorEl = document.querySelector("#shorten-error");
  const button = form.querySelector("button");
  errorEl.textContent = "";
  button.disabled = true;
  setOrb("composing");
  try {
    const { link, qr } = await api("/api/links", {
      method: "POST",
      body: Object.fromEntries(new FormData(form)),
    });
    document.querySelector("#result").innerHTML = `
      <div class="result">
        <div class="result-main">
          <p class="muted small">Seu link curto</p>
          <a class="short mono" href="${esc(link.shortUrl)}" target="_blank" rel="noopener">${esc(link.shortUrl)}</a>
          <p class="muted small truncate" title="${esc(link.targetUrl)}">Destino: ${esc(link.targetUrl)}</p>
          <div class="row">
            <button class="btn small" data-copy="${esc(link.shortUrl)}">Copiar</button>
            <a class="btn small ghost" href="#/links/${link.id}">Ver painel</a>
          </div>
        </div>
        <img class="qr" src="${esc(qr)}" alt="QR Code do link ${esc(link.code)}" width="180" height="180">
      </div>`;
    form.reset();
    await loadLinks();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    button.disabled = false;
    setOrb("working");
  }
}

async function loadLinks() {
  const target = document.querySelector("#links");
  if (!target) return;
  setOrb("searching");
  try {
    const { links } = await api("/api/links");
    document.querySelector("#count").textContent = `${links.length} ${links.length === 1 ? "link" : "links"}`;
    target.innerHTML = links.length
      ? linksTable(links)
      : `<p class="empty">Nenhum link ainda. Gere o primeiro acima.</p>`;
  } catch (error) {
    target.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  } finally {
    setOrb("working");
  }
}

function linksTable(links) {
  return `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Link</th><th>Destino</th><th class="num">Cliques</th><th>Status</th><th>Expira em</th>
        <th><span class="sr-only">Ações</span></th>
      </tr></thead>
      <tbody>
        ${links.map((link) => `
          <tr>
            <td><a class="mono" href="#/links/${link.id}">/${esc(link.code)}</a></td>
            <td class="truncate" title="${esc(link.targetUrl)}">${esc(link.targetUrl)}</td>
            <td class="num">${fmt.format(link.totalClicks)}</td>
            <td>${statusBadge(link.status)}</td>
            <td>${esc(expiryLabel(link.expiresAt))}</td>
            <td class="actions">
              <a class="btn small" href="#/links/${link.id}">Painel</a>
              <button class="btn small ghost" data-action="toggle" data-id="${link.id}" data-next="${!link.disabled}">${link.disabled ? "Ativar" : "Desativar"}</button>
              <button class="btn small danger" data-action="delete" data-id="${link.id}">Excluir</button>
            </td>
          </tr>`).join("")}
      </tbody>
    </table></div>`;
}

// ---------- Painel de um link ----------

async function renderDetail(id) {
  mount(`<p class="loading">Carregando painel…</p>`);
  setOrb("searching");
  try {
    const { link, stats } = await api(`/api/links/${id}`);
    mount(detailView(link, stats));
    document.querySelector("#expiry-form").onsubmit = onExpiry;
  } catch (error) {
    mount(`<p class="error">${esc(error.message)}</p>`);
  } finally {
    setOrb("working");
  }
}

function detailView(link, stats) {
  const t = stats.totals;
  return `
    <nav class="crumbs"><a href="#/">← Meus links</a></nav>

    <section class="hero compact card">
      <div class="row between">
        <div style="min-width:0">
          <p class="eyebrow">Painel do link</p>
          <h1 class="mono">/${esc(link.code)} ${statusBadge(link.status)}</h1>
          <p class="muted small truncate" title="${esc(link.targetUrl)}">
            Destino: <a href="${esc(link.targetUrl)}" target="_blank" rel="noopener noreferrer">${esc(link.targetUrl)}</a>
          </p>
        </div>
        <div class="row">
          <button class="btn small" data-copy="${esc(link.shortUrl)}">Copiar link</button>
          <button class="btn small ghost" data-action="toggle" data-id="${link.id}" data-next="${!link.disabled}">${link.disabled ? "Ativar" : "Desativar"}</button>
          <button class="btn small danger" data-action="delete" data-id="${link.id}">Excluir</button>
        </div>
      </div>
    </section>

    <section class="detail-top">
      <div class="card qr-card">
        <img src="/api/links/${link.id}/qr.svg" alt="QR Code de ${esc(link.shortUrl)}" width="200" height="200">
        <a class="mono small" href="${esc(link.shortUrl)}" target="_blank" rel="noopener">${esc(link.shortUrl)}</a>
      </div>
      <div class="stats">
        ${statCard("Cliques totais", fmt.format(t.total))}
        ${statCard("Últimos 7 dias", fmt.format(t.last7Days))}
        ${statCard("Visitantes únicos", fmt.format(t.uniqueVisitors))}
        ${statCard("Expira em", expiryLabel(link.expiresAt))}
      </div>
    </section>

    <section class="card">
      <div class="row between"><h2>Cliques por dia</h2><span class="muted small">últimos 30 dias (UTC)</span></div>
      ${clicksChart(stats.byDay)}
    </section>

    <section class="grid2">
      <div class="card"><h2>De onde vieram</h2>${barList(stats.sources, t.total)}</div>
      <div class="card"><h2>Dispositivo</h2>${barList(stats.devices, t.total)}</div>
      <div class="card"><h2>Navegador</h2>${barList(stats.browsers, t.total)}</div>
      <div class="card"><h2>País</h2>${barList(stats.countries, t.total)}</div>
    </section>

    <section class="grid2">
      <div class="card"><h2>Dias com mais cliques</h2>${topDaysTable(stats.topDays)}</div>
      <div class="card">
        <h2>Expiração</h2>
        <form id="expiry-form" class="stack" data-id="${link.id}">
          <label>Prazo a partir de agora
            <select name="preset">${EXPIRY_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
          </label>
          <label>Ou data exata
            <input type="date" name="date">
          </label>
          <button class="btn primary" type="submit">Salvar expiração</button>
        </form>
      </div>
    </section>

    <section class="card"><h2>Últimos cliques</h2>${recentTable(stats.recent)}</section>`;
}

function statCard(label, value) {
  return `<div class="card stat"><span class="muted small">${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function clicksChart(series) {
  const W = 720, H = 220, P = 28;
  const n = series.length;
  const max = Math.max(1, ...series.map((d) => d.clicks));
  const slot = (W - P * 2) / n;
  const barWidth = Math.max(3, slot * 0.62);

  const bars = series.map((d, i) => {
    const h = (d.clicks / max) * (H - P * 2);
    const x = P + i * slot + (slot - barWidth) / 2;
    const y = H - P - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(d.clicks ? Math.max(h, 2) : 0).toFixed(1)}" rx="3"><title>${dayLabel(d.date)}: ${d.clicks} clique(s)</title></rect>`;
  }).join("");

  const labels = series.map((d, i) =>
    i % 5 === 0 || i === n - 1
      ? `<text x="${(P + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${dayLabel(d.date)}</text>`
      : "").join("");

  const grid = [0, 0.5, 1].map((f) => {
    const y = H - P - f * (H - P * 2);
    return `<line class="grid" x1="${P}" x2="${W - P}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${P - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${Math.round(max * f)}</text>`;
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cliques por dia nos últimos ${n} dias">${grid}${bars}${labels}</svg>`;
}

function barList(items, total) {
  if (!items.length) return `<p class="empty small">Sem cliques ainda.</p>`;
  const max = Math.max(...items.map((item) => item.clicks));
  return `<ul class="bars">${items.map((item) => {
    const pct = total ? Math.round((item.clicks / total) * 100) : 0;
    return `
      <li>
        <div class="bar-label"><span>${esc(item.label)}</span><span>${fmt.format(item.clicks)} · ${pct}%</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${((item.clicks / max) * 100).toFixed(1)}%"></div></div>
      </li>`;
  }).join("")}</ul>`;
}

function topDaysTable(rows) {
  if (!rows.length) return `<p class="empty small">Sem cliques ainda.</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Dia</th><th class="num">Cliques</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><td>${esc(dayLabel(row.date))}</td><td class="num">${fmt.format(row.clicks)}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function recentTable(rows) {
  if (!rows.length) return `<p class="empty small">Nenhum clique registrado ainda.</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Quando</th><th>Origem</th><th>Dispositivo</th><th>Navegador</th><th>País</th></tr></thead>
    <tbody>${rows.map((row) => `
      <tr>
        <td>${esc(dateTime(row.at))}</td><td>${esc(row.source)}</td><td>${esc(row.device)}</td>
        <td>${esc(row.browser)}</td><td>${esc(row.country)}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

async function onExpiry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const expires = data.date ? new Date(`${data.date}T23:59:59`).toISOString() : data.preset;
  try {
    await api(`/api/links/${form.dataset.id}`, { method: "PATCH", body: { expires } });
    notify("Expiração atualizada.");
    await renderDetail(form.dataset.id);
  } catch (error) {
    notify(error.message);
  }
}

// ---------- Admin ----------

async function renderAdmin() {
  mount(`<p class="loading">Carregando painel administrativo…</p>`);
  setOrb("searching");
  try {
    const data = await api("/api/admin/overview");
    const t = data.totals;
    mount(`
      <section class="hero compact">
        <p class="eyebrow">Administração</p>
        <h1>Visão geral da plataforma</h1>
      </section>

      <section class="stats">
        ${statCard("Links criados", fmt.format(t.links))}
        ${statCard("Links ativos", fmt.format(t.activeLinks))}
        ${statCard("Cliques totais", fmt.format(t.clicks))}
        ${statCard("Cliques (7 dias)", fmt.format(t.last7Days))}
        ${statCard("Visitantes únicos", fmt.format(t.uniqueVisitors))}
        ${statCard("Usuários", fmt.format(t.users))}
      </section>

      <section class="card">
        <div class="row between"><h2>Cliques por dia</h2><span class="muted small">todos os links · 30 dias (UTC)</span></div>
        ${clicksChart(data.byDay)}
      </section>

      <section class="grid2">
        <div class="card"><h2>Origens</h2>${barList(data.sources, t.clicks)}</div>
        <div class="card"><h2>Dispositivos</h2>${barList(data.devices, t.clicks)}</div>
      </section>

      <section class="card">
        <h2>Links com mais cliques</h2>
        ${adminLinksTable(data.topLinks)}
      </section>

      <section class="card">
        <h2>Usuários</h2>
        ${usersTable(data.users)}
      </section>`);
  } catch (error) {
    mount(`<p class="error">${esc(error.message)}</p>`);
  } finally {
    setOrb("working");
  }
}

function adminLinksTable(links) {
  if (!links.length) return `<p class="empty small">Nenhum link criado ainda.</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Código</th><th>Dono</th><th>Destino</th><th class="num">Cliques</th><th>Status</th></tr></thead>
    <tbody>${links.map((link) => `
      <tr>
        <td><a class="mono" href="#/links/${link.id}">/${esc(link.code)}</a></td>
        <td>${esc(link.owner)}</td>
        <td class="truncate" title="${esc(link.targetUrl)}">${esc(link.targetUrl)}</td>
        <td class="num">${fmt.format(link.totalClicks)}</td>
        <td>${statusBadge(link.status)}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

function usersTable(users) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>E-mail</th><th>Papel</th><th class="num">Links</th><th>Criado em</th></tr></thead>
    <tbody>${users.map((user) => `
      <tr>
        <td>${esc(user.email)}</td><td>${esc(user.role)}</td>
        <td class="num">${fmt.format(user.links)}</td><td>${esc(dateTime(user.createdAt))}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

// ---------- Roteamento e eventos ----------

async function route() {
  renderNav();
  if (!state.user) return renderAuth();

  const detail = location.hash.match(/^#\/links\/(\d+)$/);
  if (detail) return renderDetail(detail[1]);

  if (location.hash === "#/admin") {
    if (state.user.role !== "admin") {
      history.replaceState(null, "", "#/");
      return renderDashboard();
    }
    return renderAdmin();
  }
  return renderDashboard();
}

document.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    await navigator.clipboard?.writeText(copyButton.dataset.copy);
    const original = copyButton.textContent;
    copyButton.textContent = "Copiado!";
    setTimeout(() => (copyButton.textContent = original), 1500);
    return;
  }

  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const { action, id } = actionEl.dataset;

  try {
    if (action === "logout") {
      await api("/api/auth/logout", { method: "POST", body: {} });
      state.user = null;
      history.replaceState(null, "", "#/");
      return route();
    }
    if (action === "toggle") {
      await api(`/api/links/${id}`, { method: "PATCH", body: { disabled: actionEl.dataset.next === "true" } });
      if (location.hash.startsWith("#/links/")) return renderDetail(id);
      return loadLinks();
    }
    if (action === "delete") {
      if (!confirm("Excluir este link e todo o histórico de cliques?")) return;
      await api(`/api/links/${id}`, { method: "DELETE" });
      history.replaceState(null, "", "#/");
      return route();
    }
  } catch (error) {
    notify(error.message);
  }
});

async function boot() {
  thinkingOrbs(headerOrb);
  try {
    const { user } = await api("/api/auth/me");
    state.user = user;
  } catch {
    state.user = null;
  }
  window.addEventListener("hashchange", route);
  await route();
}

boot();
