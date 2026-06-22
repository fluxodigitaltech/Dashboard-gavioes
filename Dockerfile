# syntax=docker/dockerfile:1.6
#
# ─────────────────────────────────────────────────────────────────────────────
# Academia Gaviões 24h — Dashboard — Multi-stage build for VPS / Easypanel deployment
#
# Stage 1: build the Vite React app with Node 20
# Stage 2: serve the static dist/ via nginx, with reverse-proxy for /evo-api
#
# ENV VARS (must be passed as Build Args or available at build time):
#   VITE_NOCODB_TOKEN
#   VITE_META_ACCESS_TOKEN
#   VITE_EVO_TOKEN_ALTINO_ARANTES
#   VITE_EVO_TOKEN_SAUDE
#   VITE_EVO_TOKEN_PARQUE_NACOES
#   VITE_EVO_TOKEN_ALTO_IPIRANGA
#   VITE_EVO_TOKEN_JARDINS
#   VITE_EVO_TOKEN_BELENZINHO
#   VITE_EVO_TOKEN_CAMPESTRE
#
# In Easypanel: paste these in Service → Environment. Easypanel passes them
# to the build automatically (sets them as ENV before `RUN npm run build`).
# ─────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:26-alpine AS build

WORKDIR /app

# Install deps first (better cache hit on source-only changes)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Vite reads VITE_* from process.env at build time — declare them as ARG so
# they can be passed via `docker build --build-arg ...` and become ENV.
# Fonte de dados = scraper (Gaviões não tem API de integração). Baked no bundle.
ARG VITE_DATA_SOURCE=scraper
ARG VITE_NOCODB_TOKEN
ARG VITE_META_ACCESS_TOKEN
ARG VITE_EVO_TOKEN_ALTINO_ARANTES
ARG VITE_EVO_TOKEN_SAUDE
ARG VITE_EVO_TOKEN_PARQUE_NACOES
ARG VITE_EVO_TOKEN_ALTO_IPIRANGA
ARG VITE_EVO_TOKEN_JARDINS
ARG VITE_EVO_TOKEN_BELENZINHO
ARG VITE_EVO_TOKEN_CAMPESTRE

ENV VITE_DATA_SOURCE=$VITE_DATA_SOURCE \
    VITE_NOCODB_TOKEN=$VITE_NOCODB_TOKEN \
    VITE_META_ACCESS_TOKEN=$VITE_META_ACCESS_TOKEN \
    VITE_EVO_TOKEN_ALTINO_ARANTES=$VITE_EVO_TOKEN_ALTINO_ARANTES \
    VITE_EVO_TOKEN_SAUDE=$VITE_EVO_TOKEN_SAUDE \
    VITE_EVO_TOKEN_PARQUE_NACOES=$VITE_EVO_TOKEN_PARQUE_NACOES \
    VITE_EVO_TOKEN_ALTO_IPIRANGA=$VITE_EVO_TOKEN_ALTO_IPIRANGA \
    VITE_EVO_TOKEN_JARDINS=$VITE_EVO_TOKEN_JARDINS \
    VITE_EVO_TOKEN_BELENZINHO=$VITE_EVO_TOKEN_BELENZINHO \
    VITE_EVO_TOKEN_CAMPESTRE=$VITE_EVO_TOKEN_CAMPESTRE

# Build (tsc -b && vite build)
RUN npm run build


# ─── Stage 2: serve ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Node runtime pro mini-backend de convites + gettext (envsubst) pro template nginx.
RUN apk add --no-cache nodejs npm gettext

# nginx.conf é um TEMPLATE: ${SCRAPER_UPSTREAM} e ${SCRAPER_TOKEN} são preenchidos
# por envsubst no boot (valores do Environment do Easypanel). Ver CMD.
COPY nginx.conf /etc/nginx/nginx.conf.template

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

# Mini-backend de convites + suas dependências (nodemailer)
COPY server /app/server
RUN cd /app/server && npm install --omit=dev --no-audit --no-fund

# Easypanel exposes the container on whatever port we pick — keep 80 for the
# default mapping. Easypanel will route http(s) traffic from the configured
# domain to this port.
EXPOSE 80

# Boot: (1) envsubst preenche o nginx.conf com SCRAPER_UPSTREAM/SCRAPER_TOKEN
# (só essas vars — os $vars do nginx ficam intactos); (2) Node em background
# (convites, porta 3001); (3) nginx em foreground. Se o Node cair, o nginx segue.
CMD ["sh", "-c", "envsubst '$SCRAPER_UPSTREAM $SCRAPER_TOKEN' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && (node /app/server/index.mjs &) && exec nginx -g 'daemon off;'"]
