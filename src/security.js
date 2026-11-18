import crypto from "node:crypto";
import { HttpError } from "./http.js";

export const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// IP nunca é guardado em claro: só HMAC com segredo do servidor (chave de rate limit).
export const hashIp = (secret, ip) => hmac(secret, `ip|${ip}`).slice(0, 32);

// Hash de visitante com sal diário: muda a cada dia, então não dá para rastrear um visitante entre dias.
export const visitorHash = (secret, day, ip, userAgent) =>
  hmac(hmac(secret, `salt|${day}`), `${ip}|${userAgent}`).slice(0, 20);

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  if (host.includes(":")) {
    // IPv6: loopback, não especificado, unique-local (fc00::/7), link-local (fe80::/10),
    // IPv4 mapeado/NAT64 (podem embutir IPv4 privado) — bloqueio conservador.
    return (
      host === "::" ||
      host === "::1" ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("::ffff:") ||
      host.startsWith("64:ff9b:")
    );
  }

  // O WHATWG URL já normaliza formas decimal/hex/octal para IPv4 com pontos.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }

  // Nome sem ponto (ex.: "intranet") resolve para host interno na maioria das redes.
  return !host.includes(".");
}

export function assertSafeTarget(raw, appHosts = new Set()) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "URL inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Use apenas URLs http ou https (javascript:, data: e file: são bloqueados).");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "URLs com usuário e senha não são aceitas.");
  }
  const host = url.hostname.toLowerCase();
  if (isPrivateHostname(host)) {
    throw new HttpError(400, "Destinos locais ou de rede privada não são permitidos.");
  }
  if (appHosts.has(host)) {
    throw new HttpError(400, "Não é possível encurtar um link do próprio encurtador.");
  }
  if (url.toString().length > 2048) {
    throw new HttpError(400, "URL muito longa (máximo 2048 caracteres).");
  }
  return url.toString();
}
