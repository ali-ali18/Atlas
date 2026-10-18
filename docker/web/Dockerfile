FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable \
	&& corepack prepare pnpm@10.33.4 --activate

# Só os manifests (package.json/lockfile): a camada de deps depende apenas
# deles (COPY --from é por conteúdo), então mudança de código NÃO reinstala
# dependências.
FROM node:20-bookworm-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out \
	&& cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/ \
	&& if [ -f .npmrc ]; then cp .npmrc /out/; fi \
	&& find apps packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' \
		-exec cp --parents {} /out/ \;

# Commit do checkout, lido do .git (sem o binário git). Sem .git, arquivo vazio.
FROM node:20-bookworm-slim AS commit
WORKDIR /src
COPY scripts/resolve-git-commit.mjs ./scripts/
COPY .gi[t] ./.git
RUN node scripts/resolve-git-commit.mjs .git /atlas-commit

FROM base AS deps
WORKDIR /app
# Instalação resiliente na VPS (ver docker/node-service.Dockerfile).
ENV CI=true \
	npm_config_store_dir=/pnpm/store \
	npm_config_fetch_retries=5 \
	npm_config_fetch_retry_mintimeout=20000 \
	npm_config_fetch_retry_maxtimeout=120000 \
	npm_config_network_concurrency=8
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=atlas-pnpm-store,target=/pnpm/store \
	n=0; until pnpm install --frozen-lockfile --filter web...; do \
		n=$((n+1)); [ "$n" -ge 3 ] && exit 1; echo "pnpm install falhou, tentativa $n/3"; sleep 15; \
	done

FROM deps AS builder
ARG ATLAS_API_INTERNAL_URL=http://api:3001
ENV ATLAS_API_INTERNAL_URL=$ATLAS_API_INTERNAL_URL
# Versão (commit) e DSN público do Sentry entram no bundle do navegador no build; vazios = desligado.
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_BUILD_CPUS=1

COPY turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# Dependências do workspace primeiro: o web importa o `dist` do @workspace/shared,
# que o .dockerignore deixa de fora do contexto.
RUN pnpm --filter "web^..." build
# webpack em vez de Turbopack: pico de ~0,9 GB contra ~1,6 GB (cabe na VPS).
# O commit entra só aqui (inlinado no cliente), depois do build das dependências.
COPY --from=commit /atlas-commit /atlas-commit
RUN NEXT_PUBLIC_ATLAS_COMMIT="$(cat /atlas-commit)" pnpm --filter web exec next build --webpack

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Maior que o idle de 90 s do Traefik: evita reutilizar conexão que o Node já fechou (502 intermitente).
ENV KEEP_ALIVE_TIMEOUT=95000

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# O standalone não inclui `public/` (ícones, imagens): sem isto, viram 404.
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=commit /atlas-commit /app/.atlas-commit

EXPOSE 3000
CMD ["sh", "-c", "ATLAS_COMMIT=$(cat /app/.atlas-commit 2>/dev/null) && export ATLAS_COMMIT; exec node apps/web/server.js"]
