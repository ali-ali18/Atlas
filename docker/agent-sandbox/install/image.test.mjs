// Testes estáticos da imagem: não dá para buildar o Docker em todo ambiente, então confere no texto
// que o root do atlas continua estreito (só o atlas-install) e que o entrypoint reinstala em segundo plano.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const dockerfile = read("Dockerfile");
const entrypoint = read("entrypoint.sh");
const sudoers = read("install/sudoers-atlas-install");
const wrapper = read("install/atlas-install");

const rules = sudoers
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith("#"));

test("sudoers: a única regra de comando é o atlas-install, sem senha, como root", () => {
	const commandRules = rules.filter((line) => !line.startsWith("Defaults"));
	assert.deepEqual(commandRules, ["atlas ALL=(root) NOPASSWD: /usr/local/bin/atlas-install"]);
});

test("sudoers: nada de apt, dpkg, shell, ALL como comando nem regra para outro usuário ou grupo", () => {
	for (const line of rules) {
		assert.doesNotMatch(line, /apt|dpkg|\/bin\/(ba)?sh|NOPASSWD:\s*ALL|SETENV|ALL\s*=\s*\(ALL/i, line);
		assert.doesNotMatch(line, /^%/, "regra de grupo");
	}
	assert.match(sudoers, /Defaults:atlas env_reset/);
});

test("Dockerfile instala o sudo e o file, e valida o sudoers no build (visudo -c)", () => {
	const aptBlock = dockerfile.slice(0, dockerfile.indexOf("# Browser oficial"));
	assert.match(aptBlock, /\n\tsudo \\\n/);
	assert.match(aptBlock, /\n\tfile \\\n/);
	assert.match(dockerfile, /visudo -c -f \/etc\/sudoers\.d\/atlas-install/);
	assert.match(dockerfile, /chmod 0440 \/etc\/sudoers\.d\/atlas-install/);
});

test("Dockerfile: atlas-install e o módulo são de root e sem escrita para o atlas", () => {
	assert.match(dockerfile, /COPY install\/atlas-install \/usr\/local\/bin\/atlas-install/);
	assert.match(dockerfile, /COPY install\/atlas-install\.mjs install\/atlas-install-lib\.mjs \/usr\/local\/lib\/atlas-install\//);
	assert.match(dockerfile, /chown -R root:root [^\n]*\/usr\/local\/bin\/atlas-install [^\n]*\/usr\/local\/lib\/atlas-install/);
	assert.match(dockerfile, /chmod 0755 \/usr\/local\/bin\/atlas-install \/usr\/local\/lib\/atlas-install/);
	assert.match(dockerfile, /chmod 0644 \/usr\/local\/lib\/atlas-install\/\*\.mjs/);
	// Nenhum chown/chmod devolve esses caminhos ao atlas.
	assert.doesNotMatch(dockerfile, /chown[^\n]*atlas:atlas[^\n]*\/usr\/local/);
	assert.doesNotMatch(dockerfile, /usermod[^\n]*sudo|adduser[^\n]*sudo|gpasswd[^\n]*sudo/);
});

test("wrapper: ambiente limpo, caminhos absolutos e o Node do sistema", () => {
	assert.match(wrapper, /^#!\/bin\/sh/);
	assert.match(wrapper, /exec \/usr\/bin\/env -i /);
	assert.match(wrapper, /\/usr\/local\/bin\/node \/usr\/local\/lib\/atlas-install\/atlas-install\.mjs "\$@"/);
	assert.doesNotMatch(wrapper.split("\n").find((l) => l.startsWith("exec")), /NODE_OPTIONS|NODE_PATH|LD_PRELOAD/);
});

test("entrypoint: prepare síncrono antes do control server e reinstall em segundo plano (&)", () => {
	const prepare = entrypoint.indexOf("/usr/local/bin/atlas-install prepare");
	const reinstall = entrypoint.indexOf("/usr/local/bin/atlas-install reinstall");
	const control = entrypoint.indexOf("node /app/control/server.mjs &");
	assert.ok(prepare > 0 && reinstall > prepare && control > reinstall, "ordem prepare -> reinstall -> control server");
	assert.match(entrypoint, /atlas-install reinstall[^\n]*\|\| true\) &/);
	assert.match(entrypoint, /chown atlas:atlas \/home\/atlas \/home\/atlas\/work/);
});

test("o container não ganha privilégios novos: o sudo precisa de setuid, então no-new-privileges não pode existir aqui", () => {
	const manager = readFileSync(new URL("../../../packages/sandbox/src/docker-manager.ts", import.meta.url), "utf8");
	assert.doesNotMatch(manager, /no-new-privileges|NoNewPrivileges/);
	assert.doesNotMatch(manager, /Privileged\s*:\s*true|CapAdd|docker\.sock/);
});

test("os arquivos do instalador existem (o wrapper é executável)", () => {
	for (const name of ["install/atlas-install.mjs", "install/atlas-install-lib.mjs", "install/sudoers-atlas-install"]) {
		assert.ok(statSync(new URL(`../${name}`, import.meta.url)).isFile(), name);
	}
	assert.ok((statSync(new URL("../install/atlas-install", import.meta.url)).mode & 0o111) !== 0);
});

// A tela do Xvfb, a janela do Chrome e a escala da screenshot do modelo precisam concordar: o modelo clica em
// coordenadas da imagem reduzida, e `modelPointToScreen` volta à tela real com o fator medido nos bytes devolvidos.
test("tela: Xvfb e janela do Chrome usam as mesmas variáveis e o mesmo padrão (1280x720)", () => {
	const chrome = read("bin/atlas-chrome");
	const xvfbW = /XVFB_W="\$\{XVFB_WIDTH:-(\d+)\}"/.exec(entrypoint)?.[1];
	const xvfbH = /XVFB_H="\$\{XVFB_HEIGHT:-(\d+)\}"/.exec(entrypoint)?.[1];
	const win = /--window-size="\$\{XVFB_WIDTH:-(\d+)\},\$\{XVFB_HEIGHT:-(\d+)\}"/.exec(chrome);
	assert.ok(xvfbW && xvfbH && win, "padrões não encontrados no entrypoint/atlas-chrome");
	// Valores reais, não só o texto: Xvfb e Chrome têm que ser iguais entre si.
	assert.equal(win[1], xvfbW, "largura da janela do Chrome diverge da tela do Xvfb");
	assert.equal(win[2], xvfbH, "altura da janela do Chrome diverge da tela do Xvfb");
	assert.deepEqual([xvfbW, xvfbH], ["1280", "720"]);
	assert.match(entrypoint, /-screen 0 "\$\{XVFB_W\}x\$\{XVFB_H\}x24"/);
	for (const m of dockerfile.matchAll(/XVFB_(WIDTH|HEIGHT)\s*=\s*(\d+)/g)) {
		assert.equal(m[2], m[1] === "WIDTH" ? xvfbW : xvfbH, "ENV do Dockerfile divergente do padrão do entrypoint");
	}
});

test("tela: o fator de escala da screenshot do modelo bate com a largura da tela", () => {
	const shared = readFileSync(new URL("../../../packages/shared/src/screenshot-scale.ts", import.meta.url), "utf8");
	const maxWidth = Number(/SCREENSHOT_MODEL_MAX_WIDTH\s*=\s*(\d+)/.exec(shared)?.[1]);
	const width = Number(/XVFB_W="\$\{XVFB_WIDTH:-(\d+)\}"/.exec(entrypoint)?.[1]);
	assert.ok(maxWidth > 0 && width > 0);
	const percent = width <= maxWidth ? 100 : Math.floor((maxWidth / width) * 100);
	// 1280 -> 1024 px de largura = 80%; a imagem devolvida tem width*percent/100 e o inverso volta à tela real.
	assert.equal(percent, 80);
	assert.equal((width * percent) / 100, maxWidth);
});

test("Dockerfile: yt-dlp (video_transcript) em tag fixa, com checksum, de root em /usr/local/bin", () => {
	const version = dockerfile.match(/^ARG YT_DLP_VERSION=(\d{4}\.\d{2}\.\d{2})$/m);
	assert.ok(version, "tag fixa AAAA.MM.DD em ARG YT_DLP_VERSION");
	assert.doesNotMatch(dockerfile, /yt-dlp\/releases\/latest/);
	assert.match(dockerfile, /releases\/download\/\$\{YT_DLP_VERSION\}\/yt-dlp"/);
	assert.match(dockerfile, /^ARG YT_DLP_SHA256=[0-9a-f]{64}$/m, "hash SHA-256 do binário fixado");
	assert.match(dockerfile, /echo "\$\{YT_DLP_SHA256\}  yt-dlp" \| sha256sum -c -/);
	assert.match(dockerfile, /install -m 0755 -o root -g root yt-dlp \/usr\/local\/bin\/yt-dlp/);
	assert.match(dockerfile, /\/usr\/local\/bin\/yt-dlp --version/);
	assert.doesNotMatch(dockerfile, /chown[^\n]*atlas[^\n]*yt-dlp/);
	// a conferência vem antes de instalar o binário
	assert.ok(dockerfile.indexOf("sha256sum --ignore-missing") < dockerfile.indexOf("install -m 0755 -o root"));
});
