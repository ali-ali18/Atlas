# Atlas agent sandbox — desktop limpo (XFCE + dock Plank) + Chrome/VS Code + noVNC + control API
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
	DISPLAY=:99 \
	SANDBOX_CONTROL_PORT=3080 \
	CDP_URL=http://127.0.0.1:9222 \
	NODE_PATH=/app/control/node_modules \
	XDG_RUNTIME_DIR=/tmp/runtime-root

RUN apt-get update && apt-get install -y --no-install-recommends \
	bash \
	ca-certificates \
	curl \
	dbus-x11 \
	file \
	fonts-dejavu \
	git \
	gnupg \
	novnc \
	openssl \
	plank \
	poppler-utils \
	procps \
	python3 \
	scrot \
	sudo \
	thunar \
	unzip \
	websockify \
	wmctrl \
	x11vnc \
	x11-xserver-utils \
	xclip \
	xdotool \
	xfce4-settings \
	xfce4-terminal \
	xfconf \
	xfdesktop4 \
	xfwm4 \
	xvfb \
	&& rm -rf /var/lib/apt/lists/*

# Browser oficial: Google Chrome (o usuário pediu Chrome, não Chromium).
RUN curl -fsSL -o /tmp/chrome.deb \
	https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends /tmp/chrome.deb \
	&& rm -f /tmp/chrome.deb \
	&& rm -rf /var/lib/apt/lists/*

# Editor: VS Code.
RUN curl -fsSL -o /tmp/code.deb \
	"https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64" \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends /tmp/code.deb \
	&& rm -f /tmp/code.deb \
	&& rm -rf /var/lib/apt/lists/*

# Wallpaper (Unsplash) + dock (Plank): Chrome / Files / Settings / Editor / Terminal.
RUN curl -fsSL -o /usr/share/backgrounds/atlas-wallpaper.jpg \
	"https://images.unsplash.com/photo-1642132786071-bf92a177282e?q=80&w=1920&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D"

# Wrappers + .desktop do dock (Chrome reusa o mesmo perfil/CDP; Thunar; Settings).
COPY bin/atlas-chrome /usr/local/bin/atlas-chrome
COPY desktop/atlas-chrome.desktop /usr/share/applications/atlas-chrome.desktop
COPY desktop/atlas-files.desktop /usr/share/applications/atlas-files.desktop
COPY desktop/atlas-settings.desktop /usr/share/applications/atlas-settings.desktop
RUN chmod +x /usr/local/bin/atlas-chrome \
	&& sed -i 's/\r$//' /usr/local/bin/atlas-chrome

COPY plank /root/.config/plank

WORKDIR /app/control
COPY control/package.json ./
RUN npm install --omit=dev

COPY control/*.mjs ./
RUN chmod -R a+rX /app/control

# Usuario nao-root para sandbox_shell/sandbox_read/...: o Chrome e o desktop rodam
# como root, mas os comandos do agente rodam como `atlas` (sem escrever no perfil
# do Chrome nem em /etc). /home/atlas/work e montado num volume por conversa.
RUN useradd --create-home --uid 1001 --shell /bin/bash atlas \
	&& mkdir -p /home/atlas/work \
	&& chown -R atlas:atlas /home/atlas

# Instalar programas: o atlas vira root para UMA coisa, o atlas-install (wrapper + validação em Node,
# de dono root e sem escrita para o atlas). O sudoers libera só esse arquivo: nada de apt-get/dpkg/shell
# com sudo (o apt-get aceita `-o APT::Update::Pre-Invoke=...`, que seria root livre). `visudo -c` quebra
# o build se o arquivo estiver errado. O que foi instalado fica registrado em /home/atlas/.atlas (volume)
# e o entrypoint reinstala quando a VM é recriada.
COPY install/atlas-install /usr/local/bin/atlas-install
COPY install/atlas-install.mjs install/atlas-install-lib.mjs /usr/local/lib/atlas-install/
COPY install/sudoers-atlas-install /etc/sudoers.d/atlas-install
RUN sed -i 's/\r$//' /usr/local/bin/atlas-install /usr/local/lib/atlas-install/*.mjs /etc/sudoers.d/atlas-install \
	&& chown -R root:root /usr/local/bin/atlas-install /usr/local/lib/atlas-install /etc/sudoers.d/atlas-install \
	&& chmod 0755 /usr/local/bin/atlas-install /usr/local/lib/atlas-install \
	&& chmod 0644 /usr/local/lib/atlas-install/*.mjs \
	&& chmod 0440 /etc/sudoers.d/atlas-install \
	&& mkdir -p /var/lib/atlas-install \
	&& visudo -c -f /etc/sudoers.d/atlas-install \
	&& visudo -c

COPY entrypoint.sh /entrypoint.sh
# Strip CRLF (checkouts no Windows com core.autocrlf quebram o shebang).
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 6080 3080

# Limites recomendados (reforçados na criação do container pelo worker/API):
# memória ~2GiB, 1+ CPU, rede bridge (documentado no README).
# TLS do noVNC: SANDBOX_TLS=true gera cert self-signed (dev). Em prod, termine
# TLS na frente (reverse proxy/app) — ver README.

ENTRYPOINT ["/entrypoint.sh"]
