import crypto from "node:crypto";
import { HttpError } from "./http.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_URL_LENGTH = 2048;
// Sem caracteres ambíguos (I, O, l, 0, 1) para o código ser fácil de ditar.
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EXPIRY_PRESETS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };

export function generateCode(length = 7) {
  let code = "";
  for (const byte of crypto.randomBytes(length)) {
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}

export function normalizeUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new HttpError(400, "Informe a URL de destino.");
  }
  let raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) {
    throw new HttpError(400, `URL muito longa (máximo ${MAX_URL_LENGTH} caracteres).`);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "URL inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Use apenas URLs http ou https.");
  }
  if (url.hostname !== "localhost" && !url.hostname.includes(".")) {
    throw new HttpError(400, "Domínio inválido.");
  }
  return url.toString();
}

export function parseExpiry(value, now = Date.now()) {
  if (value === undefined || value === null || value === "" || value === "never") return null;
  if (typeof value === "string" && Object.hasOwn(EXPIRY_PRESETS, value)) {
    return now + EXPIRY_PRESETS[value] * DAY_MS;
  }
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) {
    throw new HttpError(400, "Data de expiração inválida.");
  }
  if (date.getTime() <= now) {
    throw new HttpError(400, "A expiração precisa estar no futuro.");
  }
  return date.getTime();
}

export function linkStatus(link, now = Date.now()) {
  if (link.disabled) return "desativado";
  if (link.expires_at != null && link.expires_at <= now) return "expirado";
  return "ativo";
}
