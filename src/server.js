import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.DB_FILE ?? path.join(root, "data", "encurtador.db"));

http.createServer(createApp({ db })).listen(port, () => {
  console.log(`Encurtador rodando em http://localhost:${port}`);
});
