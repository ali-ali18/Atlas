# Atlas API / Worker / Migrate a partir do monorepo pnpm.
#
# Alvos (compose): `api` e `worker` usam o alvo final (`runner`, SERVICE=api|worker);
# `migrate` usa `--target migrate`.
#
# Cache (ordem das camadas importa):
#   base      -> só muda se o Dockerfile mudar
#   manifests -> extrai SÓ os package.json/lockfile do contexto
#   deps      -> `pnpm install`; depende apenas dos manifests, então código novo
#                NÃO reinstala dependências. Compartilhado por api/worker/migrate
#                (não usa ARG SERVICE antes deste ponto => mesma chave de cache).
#   builder   -> copia o código e compila (só esta parte roda a cada deploy)
ARG SERVICE=api

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable \
	&& corepack prepare pnpm@10.33.4 --activate

# Só os manifests. O COPY seguinte (`--from=manifests`) é por conteúdo: se os
# package.json/lockfile não mudaram, a camada de deps continua em cache mesmo
# que este estágio rode de novo por causa de mudança no código.
FROM node:22-bookworm-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out \
	&& cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/ \
	&& if [ -f .npmrc ]; then cp .npmrc /out/; fi \
	&& find apps packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' \
		-exec cp --parents {} /out/ \;

# Commit do checkout, lido do .git (sem o binário git). Sem .git, arquivo vazio.
# Estágio próprio: o hash só entra nas camadas finais, sem invalidar o cache de deps/build.
FROM node:22-bookworm-slim AS commit
WORKDIR /src
COPY scripts/resolve-git-commit.mjs ./scripts/
COPY .gi[t] ./.git
RUN node scripts/resolve-git-commit.mjs .git /atlas-commit

FROM base AS deps
WORKDIR /app
# Instalação resiliente na VPS: o deploy builda as imagens em paralelo e um
# download do registry que cai derruba o deploy inteiro. Retries + store em
# cache do BuildKit (reaproveitado entre imagens e deploys).
ENV CI=true \
	npm_config_store_dir=/pnpm/store \
	npm_config_fetch_retries=5 \
	npm_config_fetch_retry_mintimeout=20000 \
	npm_config_fetch_retry_maxtimeout=120000 \
	npm_config_network_concurrency=8
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=atlas-pnpm-store,target=/pnpm/store \
	n=0; until pnpm install --frozen-lockfile --filter 'api...' --filter 'worker...'; do \
		n=$((n+1)); [ "$n" -ge 3 ] && exit 1; echo "pnpm install falhou, tentativa $n/3"; sleep 15; \
	done

# Migrations: schema Prisma + CLI (devDependency de @workspace/db, já em `deps`).
# O `prisma generate` roda no build de api/worker (@workspace/db build).
FROM deps AS migrate
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY packages/llm ./packages/llm
WORKDIR /app/packages/db
# Roda a cada deploy (serviço `migrate` do compose): aplica as migrations
# pendentes antes de api/worker subirem.
CMD ["pnpm", "run", "db:migrate:deploy"]

FROM deps AS builder
ARG SERVICE
COPY turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter ${SERVICE}... build

FROM base AS runner
ARG SERVICE
ENV NODE_ENV=production
# Chromium só no worker (create_file -> PDF). Camada cedo: não refaz a cada deploy.
RUN if [ "$SERVICE" = "worker" ]; then 		apt-get update 		&& apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji 		&& rm -rf /var/lib/apt/lists/*; 	fi
ENV ATLAS_PDF_CHROME_PATH=/usr/bin/chromium 	ATLAS_ARTIFACT_DIR=/data/artifacts
RUN mkdir -p /data/artifacts
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/${SERVICE}/package.json ./apps/${SERVICE}/package.json
COPY --from=builder /app/apps/${SERVICE}/dist ./apps/${SERVICE}/dist
COPY --from=builder /app/apps/${SERVICE}/node_modules ./apps/${SERVICE}/node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=commit /atlas-commit /app/.atlas-commit

WORKDIR /app/apps/${SERVICE}
EXPOSE 3001

# ATLAS_COMMIT vem do arquivo gravado no build (release do Sentry e Diagnóstico).
CMD ["sh", "-c", "ATLAS_COMMIT=$(cat /app/.atlas-commit 2>/dev/null) && export ATLAS_COMMIT; exec node dist/index.js"]
