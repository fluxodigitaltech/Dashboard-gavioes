// Servidor standalone p/ puxar agregadores da EVO — independente do app React/Vite.
// Uso:  node tools/agregadores-server.mjs   →  abre http://localhost:4500
//
// O que ele faz:
//   - serve a página public/agregadores.html em  /
//   - faz proxy de  /evo-api/*  →  https://evo-integracao-api.w12app.com.br/*
//     (encaminha o header Authorization). Isso evita o erro de CORS / "Failed to fetch":
//     o navegador fala só com este servidor local; quem fala com a EVO é o Node.
//
// Sem dependências externas — usa só os módulos nativos do Node.

import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "..", "public", "agregadores.html");
const EVO_HOST = "evo-integracao-api.w12app.com.br";
const PORT = process.env.PORT || 4500;

const server = http.createServer(async (req, res) => {
  // ─── Proxy EVO ───────────────────────────────────────────────────────────
  if (req.url.startsWith("/evo-api/")) {
    const evoPath = req.url.replace(/^\/evo-api/, "");
    const upstream = https.request(
      {
        hostname: EVO_HOST,
        path: evoPath,
        method: req.method,
        headers: {
          // só repassa o que importa pra EVO
          "Authorization": req.headers["authorization"] || "",
          "Content-Type": "application/json",
          "Accept": "application/json, text/plain, */*",
          "Host": EVO_HOST,
        },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, {
          "Content-Type": up.headers["content-type"] || "application/json",
        });
        up.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Falha ao falar com a EVO", detail: String(err) }));
    });
    req.pipe(upstream);
    return;
  }

  // ─── Serve a página ──────────────────────────────────────────────────────
  if (req.url === "/" || req.url.startsWith("/agregadores")) {
    try {
      const html = await readFile(HTML_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Não encontrei public/agregadores.html ao lado do projeto.");
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Não encontrado");
});

server.listen(PORT, () => {
  console.log(`\n  Agregadores EVO rodando em:  http://localhost:${PORT}\n  (Ctrl+C para parar)\n`);
});
