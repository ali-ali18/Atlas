#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export HOME="${HOME:-/root}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-root}"
export SANDBOX_CONTROL_PORT="${SANDBOX_CONTROL_PORT:-3080}"
export CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"

XVFB_W="${XVFB_WIDTH:-1280}"
XVFB_H="${XVFB_HEIGHT:-720}"

CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome-stable}"
WEBSOCKIFY_BIN="${WEBSOCKIFY_BIN:-/usr/bin/websockify}"
WALLPAPER="${SANDBOX_WALLPAPER:-/usr/share/backgrounds/atlas-wallpaper.jpg}"

mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Volume de trabalho do agente (sandbox_shell roda como `atlas`).
mkdir -p /home/atlas/work && chown atlas:atlas /home/atlas/work 2>/dev/null || true

# Perfil do Chrome vem de volume que sobrevive a crash/OOM: locks herdados (SingletonLock/Socket/Cookie)
# fazem o Chrome recusar o perfil. Nenhum Chrome nosso roda ainda neste ponto do boot, entao sao lixo.
rm -f -- /tmp/chrome-data/SingletonLock /tmp/chrome-data/SingletonSocket /tmp/chrome-data/SingletonCookie 2>/dev/null || true

for bin in /usr/bin/Xvfb /usr/bin/xfwm4 /usr/bin/xfdesktop /usr/bin/xfsettingsd /usr/bin/plank "$CHROME_BIN" /usr/bin/x11vnc "$WEBSOCKIFY_BIN" /usr/bin/xdotool /usr/bin/scrot /usr/local/bin/node; do
	if [[ ! -x "$bin" ]]; then
		echo "[entrypoint] missing executable: $bin" >&2
		exit 127
	fi
done

echo "[entrypoint] Starting Xvfb on ${DISPLAY} (${XVFB_W}x${XVFB_H})"
# A stopped container retains X11 socket/lock files, but not its old processes.
DISPLAY_NUMBER="${DISPLAY#:}"
if [[ "$DISPLAY_NUMBER" =~ ^[0-9]+$ ]] && ! pgrep -x Xvfb >/dev/null; then
	rm -f -- "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"
fi
/usr/bin/Xvfb "${DISPLAY}" -screen 0 "${XVFB_W}x${XVFB_H}x24" -ac +extension GLX +render -noreset &
sleep 1

# Control server PRIMEIRO: /health não depende de nada (nem CDP, nem X) e é
# o que o host aguarda para considerar a sessão pronta. O desktop (XFCE,
# Chrome, VNC) continua subindo em background enquanto isso.
echo "[entrypoint] Starting control server (early)"
node /app/control/server.mjs &
CONTROL_PID=$!

# Sessão D-Bus (XFCE/apps precisam).
if command -v dbus-launch >/dev/null 2>&1; then
	eval "$(dbus-launch --sh-syntax)"
	export DBUS_SESSION_BUS_ADDRESS
fi

# XFCE minimalista: WM + desktop/settings, SEM painel/dock do XFCE.
echo "[entrypoint] Starting XFCE (sem painel)"
/usr/bin/xfsettingsd >/tmp/xfsettingsd.log 2>&1 &
/usr/bin/xfwm4 --replace >/tmp/xfwm4.log 2>&1 &
/usr/bin/xfdesktop >/tmp/xfdesktop.log 2>&1 &
sleep 2

# Wallpaper: cria o caminho padrão antes de consultar os monitores já conhecidos.
# Em uma sandbox recém-criada o XFCE ainda não tem propriedades de monitor e,
# sem isso, o loop abaixo não aplicava fundo algum.
xfconf-query -c xfce4-desktop -p /backdrop/screen0/monitor0/workspace0/image-style -n -t int -s 5 2>/dev/null || true
xfconf-query -c xfce4-desktop -p /backdrop/screen0/monitor0/workspace0/last-image -n -t string -s "$WALLPAPER" 2>/dev/null || true
for out in $(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -oE '/backdrop/screen[0-9]+/[^/]+' | sort -u); do
	xfconf-query -c xfce4-desktop -p "$out/workspace0/image-style" -t int -s 5 2>/dev/null || true
	xfconf-query -c xfce4-desktop -p "$out/workspace0/last-image" -t string -s "$WALLPAPER" 2>/dev/null || true
done

# Sem ícones na área de trabalho (nada além do dock/bg).
xfconf-query -c xfce4-desktop -p /desktop-icons/style -n -t int -s 0 2>/dev/null || true

# File Manager padrão = Thunar; browser padrão = Chrome da sandbox.
mkdir -p "$HOME/.config"
cat > "$HOME/.config/mimeapps.list" <<'EOF'
[Default Applications]
inode/directory=atlas-files.desktop
x-scheme-handler/http=atlas-chrome.desktop
x-scheme-handler/https=atlas-chrome.desktop
text/html=atlas-chrome.desktop
EOF

# Dock: somente Chrome, Terminal e Thunar.
echo "[entrypoint] Starting Plank dock"
mkdir -p "$XDG_CONFIG_HOME/plank/dock1"
if [[ ! -d "$XDG_CONFIG_HOME/plank/dock1/launchers" ]]; then
	cp -a /root/.config/plank/dock1/. "$XDG_CONFIG_HOME/plank/dock1/" 2>/dev/null || true
fi
/usr/bin/plank >/tmp/plank.log 2>&1 &

echo "[entrypoint] Starting Google Chrome (CDP on 9222)"
# Mesmo launcher do control server: limpa Singleton* herdados do volume.
/usr/local/bin/atlas-chrome about:blank >/tmp/chrome.log 2>&1 &

for _ in $(seq 1 40); do
	if curl -sf "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
		break
	fi
	 sleep 0.5
done

if ! curl -sf "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
	# Não aborta: o control server já está no ar e as ferramentas de browser
	# fazem retry/launch próprio no primeiro uso (browser-session.mjs).
	echo "[entrypoint] WARNING: Chrome CDP not ready after 20s — continuing without it" >&2
fi

# Sem sino: o X bell (Chrome/xfwm4) chegava ao noVNC como RFB Bell e tocava um bip.
xset -display "${DISPLAY}" b off 2>/dev/null || true

echo "[entrypoint] Starting x11vnc"
# -nobell: não repassa o sino do X ao cliente. Em loop: se o x11vnc cair, o
# websockify ficaria recusando e o noVNC em "Reconectando" para sempre.
(
	while true; do
		/usr/bin/x11vnc -display "${DISPLAY}" -forever -shared -rfbport 5900 -nopw -localhost -nobell || true
		sleep 1
	done
) &
sleep 1

# noVNC: HTTP por padrão; com SANDBOX_TLS=true gera cert self-signed e usa WSS.
# --heartbeat: ping WebSocket a cada 20 s; tela parada não gera tráfego e proxies
# (Cloudflare/nginx) derrubam conexões ociosas, o que disparava o "Reconectando".
WEBSOCKIFY_ARGS=(--heartbeat 20 --web /usr/share/novnc 6080 localhost:5900)
if [[ "${SANDBOX_TLS:-false}" == "true" || "${SANDBOX_TLS:-false}" == "1" ]]; then
	CERT_DIR=/etc/atlas-sandbox
	mkdir -p "$CERT_DIR"
	if [[ ! -f "$CERT_DIR/cert.pem" ]]; then
		openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
			-keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
			-subj "/CN=atlas-sandbox" >/dev/null 2>&1
	fi
	WEBSOCKIFY_ARGS=(--heartbeat 20 --web /usr/share/novnc --cert "$CERT_DIR/cert.pem" --key "$CERT_DIR/key.pem" 6080 localhost:5900)
	echo "[entrypoint] noVNC TLS enabled (self-signed) — use viewerHost https://"
fi

# noVNC sem barra de controle: o viewer é só a tela (autoconnect já ativo).
# Esconde a barra/handle para não poluir o iframe.
NOVNC_CSS=/usr/share/novnc/app/styles/base.css
if [ -f "$NOVNC_CSS" ] && ! grep -q "atlas-hide-control-bar" "$NOVNC_CSS"; then
  cat >> "$NOVNC_CSS" <<'EOF'
/* atlas-hide-control-bar: esconde a barra de controle e o dialogo Conectar do noVNC */
#noVNC_control_bar, #noVNC_control_bar_handle, #noVNC_connect_dlg { display: none !important; }
EOF
fi

echo "[entrypoint] Starting noVNC (websockify on 6080)"
"$WEBSOCKIFY_BIN" "${WEBSOCKIFY_ARGS[@]}" &

# Control server já iniciado lá em cima (early); aqui só aguardamos o /health
# como sinal de prontidão para o log (não bloqueia nada).

for _ in $(seq 1 60); do
	if curl -sf "http://127.0.0.1:${SANDBOX_CONTROL_PORT}/health" >/dev/null 2>&1; then
		echo "[entrypoint] Control server ready on port ${SANDBOX_CONTROL_PORT}"
		break
	fi
	sleep 0.5
done

# Mantém o container vivo; não usar `wait` com set -e.
while kill -0 "$CONTROL_PID" 2>/dev/null; do
	sleep 30
done

echo "[entrypoint] Control server exited" >&2
exit 1
