# Sessão de desenvolvimento do agente: container leve (sem desktop/VNC/Chrome)
# com git, gh, node+pnpm, python e ferramentas de build. Um container por sessão.
# Build: docker build -t atlas-dev-sandbox:latest docker/dev-sandbox
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
	DEV_SANDBOX_PORT=3090 \
	DEV_WORKSPACE=/workspace \
	DEV_USER_HOME=/home/dev \
	PNPM_HOME=/cache/pnpm-home \
	PNPM_STORE_DIR=/cache/pnpm \
	npm_config_cache=/cache/npm \
	PIP_CACHE_DIR=/cache/pip \
	XDG_CACHE_HOME=/cache/xdg \
	COREPACK_HOME=/cache/corepack \
	CARGO_HOME=/cache/cargo \
	UV_CACHE_DIR=/cache/uv \
	GOMODCACHE=/cache/go-mod \
	YARN_CACHE_FOLDER=/cache/yarn \
	BUN_INSTALL_CACHE_DIR=/cache/bun \
	DEV_IMAGE_VERSION=2 \
	COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
	PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update && apt-get install -y --no-install-recommends \
	bash \
	build-essential \
	ca-certificates \
	curl \
	git \
	gnupg \
	jq \
	openssh-client \
	procps \
	python3 \
	python3-pip \
	python3-venv \
	ripgrep \
	unzip \
	zip \
	&& mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable \
	&& corepack prepare pnpm@latest --activate

# O token do GitHub entra só no ambiente de cada comando (GH_TOKEN); nada é gravado em disco.
RUN git config --system credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
	&& git config --system init.defaultBranch main \
	&& git config --system --add safe.directory '*' \
	&& git config --system user.name "Assistente" \
	&& git config --system user.email "assistente@users.noreply.github.com"

RUN useradd --create-home --uid 1001 --shell /bin/bash dev \
	&& mkdir -p /workspace /cache /envcache /app \
	&& chown -R dev:dev /workspace /cache /envcache /home/dev

COPY --chown=dev:dev server.mjs egress-gateway.mjs /app/
COPY --chown=dev:dev server/ /app/server/

USER dev
WORKDIR /workspace
VOLUME ["/workspace", "/cache"]
EXPOSE 3090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEV_SANDBOX_PORT||3090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
