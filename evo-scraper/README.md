# 🤖 Gaviões EVO Scraper

Serviço headless que extrai dados do W12 EVO5 (`evo5.w12app.com.br`) e empurra
pra NocoDB que o dashboard Gaviões consome. Construído pra contornar a limitação
da franqueadora não liberar a API de integração pra Gaviões — em vez de token
Basic, ele loga na CONTA WEB como um usuário humano. (Portado do scraper BlueFit,
que usa exatamente a mesma técnica.)

**Stack:** Node 20 · TypeScript · Playwright (Chromium) · Express 5 · NocoDB
**Deploy:** Docker (Easypanel/VPS)
**Trigger:** HTTP POST do dashboard OU cron interno

---

## Como funciona (TL;DR)

1. Dashboard tem botão **"Puxar dados EVO"**.
2. Click envia `POST /sync` pro scraper (HTTP, com Bearer token).
3. Scraper sobe Chromium headless, restaura sessão salva (ou faz login UI completo se sessão expirou).
4. Navega pelas páginas do EVO5 (membros, vendas, recebimentos, entradas).
5. Captura XHR + DOM, extrai os números, salva snapshot na tabela `bf_evo_snapshots` da NocoDB.
6. Dashboard fica fazendo polling em `GET /sync/:id` pra mostrar progresso.
7. Ao terminar, dashboard recarrega e usa os dados frescos.

Cookies do EVO ficam em volume Docker persistente (`/app/session`). Login UI roda
~1× por dia (sessão dura horas). Demais runs reusam cookies → ~5s por filial.

---

## Setup local

```bash
cd evo-scraper
cp .env.example .env
# preenche credenciais EVO + NocoDB no .env
npm install
npx playwright install chromium    # baixa o browser

# 1. Testa só o login (debug rápido sem rodar pipeline inteiro)
npm run test:login

# 2. Discovery mode — loga todo XHR pra mapear endpoints reais do EVO5
npm run discover

# 3. Roda 1 ciclo de scrape no terminal
npm run test:run

# 4. Sobe o servidor HTTP
npm run dev
```

Servidor sobe em `http://localhost:8088`.

### Testar via HTTP

```bash
TOKEN="$(grep ^SCRAPER_TOKEN .env | cut -d= -f2)"

# Health
curl http://localhost:8088/health

# Disparar sync (dashboard fará isso via fetch)
curl -X POST http://localhost:8088/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branches":["312"]}'
# → { "jobId": "abc123...", "status": "pending" }

# Polling do progresso
curl http://localhost:8088/sync/abc123 \
  -H "Authorization: Bearer $TOKEN"

# Último sync que deu certo
curl http://localhost:8088/last-sync -H "Authorization: Bearer $TOKEN"
```

---

## Workflow recomendado (primeira vez)

### Passo 1: Discovery

A primeira responsabilidade é mapear quais endpoints internos o EVO5 chama.
Roda:

```bash
npm run discover
```

Isso abre o Chromium (visível se `PLAYWRIGHT_HEADLESS=false` no `.env`),
faz login, navega por: `/inicio/geral`, `/membros`, `/vendas`, `/financeiro/recebimentos`,
`/relatorios/entradas`. Pra cada XHR/fetch que sair, captura método + URL + body.

Saída fica em `discovery/<timestamp>.discover.json`. O console também imprime
um resumo dos endpoints únicos:

```
=== unique endpoints captured ===
   12× GET https://evo5.w12app.com.br/api/branches/312/members
    8× GET https://evo5.w12app.com.br/api/branches/312/sales
   ...
```

### Passo 2: Refinar extractors

Com o discovery em mãos, atualizar os 4 arquivos em `src/extractors/`:
- `members.ts` — endpoint dos membros e como parsear
- `sales.ts` — endpoint das vendas/matrículas
- `receivables.ts` — endpoint dos recebimentos
- `entries.ts` — endpoint da catraca/entradas

Cada um tem 2 caminhos: tenta API (se mapeada), senão cai no scraping de DOM.
Os stubs atuais já tentam padrões comuns + têm regex de DOM como fallback.

### Passo 3: Validar ponta a ponta

```bash
npm run test:run
```

Deve imprimir summary com `active`, `inactive`, `todayEntries` > 0, e criar
um registro novo na tabela `bf_evo_snapshots` da NocoDB.

### Passo 4: Deploy

Ver seção abaixo.

---

## Deploy Easypanel

1. **Criar serviço Docker** apontando pro repo (ou usar build remoto).
2. **Variáveis de ambiente** (Service → Environment):
   ```
   SCRAPER_TOKEN=<openssl rand -hex 32>
   CORS_ORIGINS=https://dashboard.bluefitatlantica.com.br
   EVO_USERNAME=bruno.boucada@bluefitacademia.com.br
   EVO_PASSWORD=Bru123456!
   EVO_BRANCH_IDS=312
   EVO_TENANT=bluefit
   PLAYWRIGHT_HEADLESS=true
   NOCODB_BASE=https://desk-nocodb.5y4hfw.easypanel.host
   NOCODB_TOKEN=<seu token NocoDB>
   NOCODB_TABLE_EVO_SNAPSHOT=mmxysyec5hhcjsz
   CRON_INTERVAL_MS=10800000   # 3h — opcional, deixa 0 pra só rodar quando dashboard pedir
   ```
3. **Volume persistente**: montar `/app/session` em volume Docker pra não perder
   cookies a cada redeploy (login UI tem que rodar de novo do zero senão).
4. **Porta**: expor `8088`.
5. **Domínio**: opcional. Se expor publicamente, garantir que `SCRAPER_TOKEN` é
   forte e que `CORS_ORIGINS` está limitado ao dashboard.
6. **Build**: Easypanel detecta o `Dockerfile`. Build leva ~2min (download da
   imagem oficial Playwright é a parte demorada).

### Configurar dashboard pra falar com o scraper

No `.env` do `dashboard-bluefit/`, adicionar:
```
VITE_SCRAPER_BASE=https://evo-scraper.suaempresa.com   # ou http://localhost:8088 em dev
VITE_SCRAPER_TOKEN=<MESMO valor de SCRAPER_TOKEN>
```

Depois rebuild do dashboard (env é embarcado em build time).

---

## API Reference

| Método | Path | Auth | Descrição |
|---|---|---|---|
| `GET` | `/health` | nenhum | Healthcheck `{ ok: true }` |
| `POST` | `/sync` | Bearer | Enfileira job. Body: `{ branches?: string[] }`. Retorna `{ jobId, status }` |
| `GET` | `/sync/:id` | Bearer | Status do job (pra polling) |
| `GET` | `/sync` | Bearer | Lista últimos 20 jobs |
| `GET` | `/last-sync` | Bearer | Info do último sync OK |

### Estados do job

`pending` → `running` → `done | failed`. Progress reporta `{ step, percent }`
em tempo real durante `running`.

---

## Layout dos arquivos

```
src/
├── index.ts                 # Entry point — sobe Express + cron
├── config.ts                # Carrega .env e valida
├── server.ts                # Routes Express
├── jobs.ts                  # Job queue in-memory + processor
├── auth.ts                  # Playwright login + storageState persistente
├── discover.ts              # Discovery mode (mapeia endpoints XHR)
├── storage.ts               # Push pra NocoDB
├── extractors/
│   ├── index.ts             # Coordena os 4 extractors
│   ├── members.ts           # Ativos/Inativos/VIPs
│   ├── sales.ts             # Matrículas do mês
│   ├── receivables.ts       # Financeiro
│   └── entries.ts           # Catraca / acessos
├── cli/
│   ├── discover.ts          # CLI: npm run discover
│   ├── test-login.ts        # CLI: npm run test:login
│   └── test-run.ts          # CLI: npm run test:run
└── lib/
    └── logger.ts            # Pino logger
```

---

## Segurança e operação

- 🔐 **Credenciais EVO** ficam SÓ no servidor. Nunca expostas ao client.
- 🔐 **SCRAPER_TOKEN** é o único guardião do endpoint `/sync`. Use 32+ bytes random.
- 🔐 **CORS** estrito — só origens listadas. Token sozinho não basta se o token
  for embarcado no JS público do dashboard (alguém pode achar em DevTools).
  A combinação CORS + Token reduz a superfície.
- 🍪 **storageState** (`/app/session/storageState.json`) contém cookies de sessão
  do EVO. Nunca commitar. Volume Docker isolado.
- 🔁 **Re-login automático**: se um scrape recebe redirect pra `/login`, o storage
  é invalidado e o próximo job re-loga via UI.
- 🚦 **Concurrency**: só 1 job por vez. Próximos ficam na fila in-memory.
  Em deploy multi-instance precisaria mover pra Redis/BullMQ.
- 📊 **Monitoramento**: logs JSON estruturados (Pino). Easypanel/Loki digerem direto.

---

## Limitações conhecidas

1. **Job queue é in-memory** — se o container reinicia, fila se perde. OK pro caso
   de uso atual; pra resiliência maior, migrar pra Redis/BullMQ.
2. **Playwright é caro** — RAM ~300-500MB durante scrape. Easypanel: dimensionar
   pelo menos 1GB RAM.
3. **Cloudflare pode escalar challenge** se rodar muito frequente. Por isso não
   recomendo `CRON_INTERVAL_MS` < 1h.
4. **Selectors do form de login** podem mudar se o EVO atualizar a UI. Se o
   `test:login` falhar com "selectors changed", rodar `npm run discover` de novo
   pra remapear.
5. **Idempotência**: cada job cria um snapshot novo. Se rodar 10× no mesmo dia
   ficam 10 linhas. O dashboard deve consumir o mais recente por filial.

---

## Próximos passos sugeridos

- [ ] Rodar `npm run discover` e refinar `extractors/*.ts` com endpoints reais
- [ ] Testar `npm run test:run` end-to-end na máquina dev
- [ ] Configurar Easypanel + volume `/app/session`
- [ ] Configurar dashboard com `VITE_SCRAPER_BASE` e `VITE_SCRAPER_TOKEN`
- [ ] Testar sync via UI do dashboard
- [ ] (Opcional) Habilitar `CRON_INTERVAL_MS=10800000` (3h) pra refresh automático
