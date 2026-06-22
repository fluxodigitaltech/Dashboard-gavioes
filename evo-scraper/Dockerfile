# syntax=docker/dockerfile:1.6
#
# ─────────────────────────────────────────────────────────────────────────────
# BlueFit EVO Scraper — imagem Node + Playwright (Chromium) pra Easypanel/VPS
#
# Usa a imagem oficial mcr.microsoft.com/playwright que JÁ vem com:
#   - Node 20
#   - Chromium + Firefox + WebKit
#   - Todas libs nativas do Linux que o browser headless precisa (evita o
#     pesadelo de instalar libnss3/libxshmfence/etc no Alpine)
#
# A imagem é grande (~1.2GB) mas é o padrão pra Playwright em prod.
# Pra Easypanel: configurar serviço como Docker, expor porta 8088.
# ─────────────────────────────────────────────────────────────────────────────

FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# ── Build: instala deps + compila TS ─────────────────────────────────────────
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Mantém só prod deps na imagem final
RUN npm prune --omit=dev

# ── Runtime config ───────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=8088
EXPOSE 8088

# Pasta pra storageState (cookies persistentes). Em Easypanel, montar como
# volume pra não perder a sessão a cada redeploy.
VOLUME ["/app/session"]

# Healthcheck (Easypanel também faz check próprio, mas Docker nativo ajuda em VPS direto)
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
