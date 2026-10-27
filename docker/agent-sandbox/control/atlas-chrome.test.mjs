// Lançador do Chrome: trava contra dois Chromes no mesmo perfil, Preferences e restauração de sessão.
// Usa um "Chrome" falso (script que registra os argumentos e dorme); nada de rede nem de Chrome real.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "atlas-chrome");
let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atlas-chrome-"));
	writeFileSync(join(dir, "fake-chrome"), `#!/usr/bin/env bash\necho "$*" >> "${dir}/launches.log"\nsleep \${FAKE_CHROME_SLEEP:-0}\n`);
	chmodSync(join(dir, "fake-chrome"), 0o755);
	mkdirSync(join(dir, "profile"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (extra = {}) => ({
	...process.env,
	CHROME_BIN: join(dir, "fake-chrome"),
	CHROME_USER_DATA_DIR: join(dir, "profile"),
	ATLAS_CHROME_LOCK_WAIT_S: "1",
	...extra,
});
const run = (args = ["about:blank"], extra = {}) => spawnSync("bash", [SCRIPT, ...args], { env: env(extra), encoding: "utf8" });
const launches = () => (existsSync(join(dir, "launches.log")) ? readFileSync(join(dir, "launches.log"), "utf8").trim().split("\n") : []);
const prefs = () => JSON.parse(readFileSync(join(dir, "profile", "Default", "Preferences"), "utf8"));

test("bash -n: sintaxe válida", () => {
	assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
});

test("grava saída limpa e 'continuar de onde parou' (cookie de sessão sobrevive) e preserva o resto", () => {
	mkdirSync(join(dir, "profile", "Default"), { recursive: true });
	writeFileSync(join(dir, "profile", "Default", "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", name: "x" }, other: 1 }));
	assert.equal(run().status, 0);
	const saved = prefs();
	assert.equal(saved.profile.exit_type, "Normal");
	assert.equal(saved.profile.exited_cleanly, true);
	assert.equal(saved.profile.name, "x");
	assert.equal(saved.session.restore_on_startup, 1);
	assert.equal(saved.other, 1);
	assert.match(launches()[0], /--restore-last-session/);
});

test("perfil novo ou Preferences inválido: o Chrome sobe e a preferência é criada", () => {
	assert.equal(run().status, 0);
	assert.equal(prefs().session.restore_on_startup, 1);
	writeFileSync(join(dir, "profile", "Default", "Preferences"), "{nao e json");
	assert.equal(run().status, 0);
	assert.equal(prefs().session.restore_on_startup, 1);
	assert.equal(launches().length, 2);
});

test("about:blank só vai para o Chrome quando não há sessão anterior para restaurar", () => {
	run(["about:blank"]);
	assert.match(launches()[0], /about:blank/);
	mkdirSync(join(dir, "profile", "Default", "Sessions"), { recursive: true });
	writeFileSync(join(dir, "profile", "Default", "Sessions", "Session_1"), "x");
	run(["about:blank", "https://example.com"]);
	assert.doesNotMatch(launches()[1], /about:blank/);
	assert.match(launches()[1], /https:\/\/example\.com/);
});

test("dois lançamentos ao mesmo tempo abrem um único Chrome (a trava fica com o Chrome)", async () => {
	const start = () =>
		new Promise((resolve) => {
			const child = spawn("bash", [SCRIPT, "about:blank"], { env: env({ FAKE_CHROME_SLEEP: "3" }), stdio: "ignore" });
			child.once("exit", (code) => resolve(code));
		});
	const first = start();
	await new Promise((r) => setTimeout(r, 300));
	const second = await start();
	assert.equal(second, 1, "o segundo não abre outro Chrome no mesmo perfil");
	assert.equal(launches().length, 1);
	await first;
});

test("apaga Singleton* herdados do volume sob a trava", () => {
	writeFileSync(join(dir, "profile", "SingletonLock"), "x");
	assert.equal(run().status, 0);
	assert.equal(existsSync(join(dir, "profile", "SingletonLock")), false);
});
