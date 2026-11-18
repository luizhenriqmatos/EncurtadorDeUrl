import { thinkingOrbs } from "/thinking-orbs.js";

const orb = document.querySelector("#unlock-orb");
const headerOrb = document.querySelector("#unlock-header-orb");
const form = document.querySelector("#unlock-form");
const errorEl = document.querySelector("#unlock-error");
const button = form.querySelector("button");
const code = new URLSearchParams(location.search).get("c") ?? "";

// Estados: listening (aguardando), solving (validando), shaping (liberado).
function setOrb(target, orbState) {
  target.dataset.orbState = orbState;
  thinkingOrbs(target);
}

if (!/^[A-Za-z0-9-]{3,32}$/.test(code)) {
  errorEl.textContent = "Link inválido.";
  button.disabled = true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  button.disabled = true;
  setOrb(orb, "solving");
  setOrb(headerOrb, "solving");
  try {
    const response = await fetch(`/api/unlock/${encodeURIComponent(code)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: form.elements.password.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível validar a senha.");

    setOrb(orb, "shaping");
    setOrb(headerOrb, "shaping");
    errorEl.textContent = "Liberado. Redirecionando…";
    // O cookie de desbloqueio já está setado: o GET /:code agora responde 302 e conta o clique.
    location.replace(data.redirect ?? `/${code}`);
  } catch (error) {
    errorEl.textContent = error.message;
    setOrb(orb, "listening");
    setOrb(headerOrb, "working");
    button.disabled = false;
  }
});

setOrb(orb, "listening");
setOrb(headerOrb, "working");
