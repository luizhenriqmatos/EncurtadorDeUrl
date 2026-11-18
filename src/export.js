// Exportação CSV segura: escapa aspas/separadores e neutraliza fórmulas (=, +, -, @) do Excel/Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let text = String(value ?? "");
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  // BOM UTF-8 para o Excel reconhecer acentos.
  return `﻿${lines.join("\r\n")}\r\n`;
}
