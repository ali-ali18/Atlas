import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createExecManager, ExecError, redact, sanitizeEnv, clampTimeout } from "../server/exec-jobs.mjs";

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const skip = (process.platform !== "win32" || process.env.DEV_TEST_FORCE_EXEC) && hasBash ? false : "requer bash/POSIX";

function manager() {
	const dir = os.tmpdir();
	return createExecManager({ workspace: dir, home: dir, confine: async (p) => (typeof p === "string" ? p : dir) });
}

async function waitEnded(job, ms = 10_000) {
	const t0 = Date.now();
	while (!job.endedAt && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
}

test("sanitizeEnv bloqueia variáveis perigosas e coleta segredos", () => {
	assert.throws(() => sanitizeEnv({ LD_PRELOAD: "x" }), ExecError);
	assert.throws(() => sanitizeEnv({ "1BAD": "x" }), ExecError);
	const { env, secrets } = sanitizeEnv({ GH_TOKEN: "ghp_secret123", FOO: "bar" });
	assert.deepEqual(secrets, ["ghp_secret123"]);
	assert.equal(env.FOO, "bar");
	assert.equal(redact("x ghp_secret123 y", secrets), "x *** y");
});

test("clampTimeout aplica piso, teto e padrão", () => {
	assert.equal(clampTimeout(undefined), 120_000);
	assert.equal(clampTimeout(10), 1_000);
	assert.equal(clampTimeout(1e12), 30 * 60_000);
});

test("primeiro plano devolve saída e código de saída", { skip }, async () => {
	const r = await manager().run({ cmd: "echo oi; echo erro 1>&2; exit 3" });
	assert.equal(r.exitCode, 3);
	assert.match(r.stdout, /oi/);
	assert.match(r.stderr, /erro/);
	assert.equal(r.running, false);
});

test("segredo no env é redigido da saída", { skip }, async () => {
	const r = await manager().run({ cmd: 'echo "$GH_TOKEN"', env: { GH_TOKEN: "ghp_topsecret_value" } });
	assert.ok(!r.stdout.includes("ghp_topsecret_value"));
	assert.match(r.stdout, /\*\*\*/);
});

test("timeout mata o processo", { skip }, async () => {
	const m = manager();
	const job = await m.start({ cmd: "sleep 30", timeoutMs: 1000 });
	await waitEnded(job);
	assert.ok(job.endedAt, "deveria ter terminado");
	assert.equal(m.snapshot(job).timedOut, true);
});

test("background + poll incremental + kill", { skip }, async () => {
	const m = manager();
	const job = await m.start({ cmd: "echo primeiro; sleep 30" });
	const snap = await m.poll(job.id, { waitMs: 3000 });
	assert.equal(snap.running, true);
	assert.match(snap.stdout, /primeiro/);
	const again = await m.poll(job.id, { out: snap.nextOut, waitMs: 0 });
	assert.equal(again.stdout, "");
	m.kill(job.id);
	await waitEnded(job, 8000);
	assert.ok(job.endedAt);
	assert.equal(m.snapshot(job).status, "killed");
});

test("stdin chega ao processo", { skip }, async () => {
	const m = manager();
	const job = await m.start({ cmd: "read x; echo got:$x" });
	m.stdin(job.id, { data: "ola\n" });
	const snap = await m.poll(job.id, { waitMs: 3000 });
	assert.match(snap.stdout, /got:ola/);
});

test("job desconhecido dá 404", () => {
	assert.throws(
		() => manager().get("deadbeef0000"),
		(e) => e instanceof ExecError && e.status === 404,
	);
});

test("normalizeCmd ignora espaços, quebras de linha e ; finais", async () => {
	const { normalizeCmd } = await import("../server/exec-jobs.mjs");
	assert.equal(normalizeCmd("  pnpm   install\n --frozen-lockfile ; "), "pnpm install --frozen-lockfile");
	assert.equal(normalizeCmd("cd /w && pnpm i &&"), "cd /w && pnpm i");
});

test("findRunning devolve o job idêntico ainda rodando (dedupe) e ignora o que terminou", async () => {
	const { EventEmitter } = await import("node:events");
	const children = [];
	const spawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = null;
		child.pid = undefined;
		child.kill = () => undefined;
		children.push(child);
		return child;
	};
	const dir = os.tmpdir();
	const m = createExecManager({ spawn, workspace: dir, home: dir, confine: async (p) => (typeof p === "string" ? p : dir) });
	const job = await m.start({ cmd: "pnpm install --frozen-lockfile" });
	const dup = await m.findRunning({ cmd: "  pnpm install   --frozen-lockfile;" });
	assert.equal(dup?.id, job.id);
	assert.equal(await m.findRunning({ cmd: "pnpm test" }), null);
	children[0].emit("close", 0, null);
	assert.equal(await m.findRunning({ cmd: "pnpm install --frozen-lockfile" }), null);
});

test("ambiente padrão dos comandos: CI e timeouts de rede para falhar rápido", async () => {
	const { NETWORK_DEFAULTS } = await import("../server/exec-jobs.mjs");
	assert.equal(NETWORK_DEFAULTS.npm_config_fetch_timeout, "60000");
	assert.equal(NETWORK_DEFAULTS.npm_config_fetch_retries, "2");
	let seenEnv;
	const { EventEmitter } = await import("node:events");
	const spawn = (_c, _a, opts) => {
		seenEnv = opts.env;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = null;
		return child;
	};
	const dir = os.tmpdir();
	await createExecManager({ spawn, workspace: dir, home: dir, confine: async () => dir }).start({ cmd: "true" });
	assert.equal(seenEnv.CI, "true");
	assert.equal(seenEnv.npm_config_fetch_timeout, "60000");
});

test("poll com waitMs longo volta NA HORA em que o job termina (sem intervalo fixo)", { skip }, async () => {
	const m = manager();
	const job = await m.start({ cmd: "sleep 0.4; exit 0" });
	const t0 = Date.now();
	const snap = await m.poll(job.id, { waitMs: 25_000 });
	const waited = Date.now() - t0;
	assert.equal(snap.running, false);
	assert.equal(snap.exitCode, 0);
	assert.ok(waited < 3_000, `esperou ${waited}ms; deveria acordar no fim do job`);
});

test("poll com waitMs longo volta assim que chega saída nova", { skip }, async () => {
	const m = manager();
	const job = await m.start({ cmd: "sleep 0.4; echo primeira; sleep 30" });
	const t0 = Date.now();
	const snap = await m.poll(job.id, { waitMs: 25_000 });
	assert.equal(snap.running, true);
	assert.match(snap.stdout, /primeira/);
	assert.ok(Date.now() - t0 < 3_000);
	m.kill(job.id);
	await waitEnded(job, 8000);
});

test("run em primeiro plano devolve logo que o comando termina", { skip }, async () => {
	const m = manager();
	const t0 = Date.now();
	const r = await m.run({ cmd: "echo rapido" });
	assert.equal(r.exitCode, 0);
	assert.ok(Date.now() - t0 < 2_000);
});

async function fakeManager(extra = {}) {
	const { EventEmitter } = await import("node:events");
	const children = [];
	const spawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = null;
		child.pid = undefined;
		child.kill = () => undefined;
		children.push(child);
		return child;
	};
	const dir = os.tmpdir();
	const m = createExecManager({ spawn, workspace: dir, home: dir, confine: async (p) => (typeof p === "string" ? p : dir), ...extra });
	return { m, children };
}

test("primeiro plano que passa de autoBackgroundMs vira job (não é morto) e o callback de fim dispara", async () => {
	const ended = [];
	const { m, children } = await fakeManager({ onEnd: (e) => ended.push(e) });
	const t0 = Date.now();
	const run = m.run({ cmd: "sleep 100", autoBackgroundMs: 1_000 });
	await new Promise((r) => setTimeout(r, 20));
	children[0].stdout.emit("data", Buffer.from("parcial\n"));
	const r = await run;
	assert.ok(Date.now() - t0 >= 900);
	assert.equal(r.backgrounded, true);
	assert.equal(r.running, true);
	assert.equal(r.timedOut, false);
	assert.match(r.stdout, /parcial/);
	assert.equal(m.list().find((j) => j.id === r.id)?.running, true);
	assert.equal(ended.length, 0);
	children[0].emit("close", 0, null);
	assert.equal(ended.length, 1);
	assert.equal(ended[0].jobId, r.id);
	assert.equal(ended[0].exitCode, 0);
});

test("primeiro plano que termina antes do auto-background volta completo e sem aviso de fim", async () => {
	const ended = [];
	const { m, children } = await fakeManager({ onEnd: (e) => ended.push(e) });
	const run = m.run({ cmd: "true", autoBackgroundMs: 30_000 });
	await new Promise((r) => setTimeout(r, 20));
	children[0].stdout.emit("data", Buffer.from("feito\n"));
	children[0].emit("close", 0, null);
	const r = await run;
	assert.equal(r.backgrounded, undefined);
	assert.equal(r.running, false);
	assert.equal(r.exitCode, 0);
	assert.equal(ended.length, 0);
});

test("poll com until volta assim que a saída nova casa (substring e regex) e marca matched", async () => {
	const { m, children } = await fakeManager();
	const job = await m.start({ cmd: "dev" });
	const t0 = Date.now();
	const waiting = m.poll(job.id, { waitMs: 20_000, until: "ready on port" });
	setTimeout(() => children[0].stdout.emit("data", Buffer.from("compilando\n")), 50);
	setTimeout(() => children[0].stdout.emit("data", Buffer.from("ready on port 3000\n")), 150);
	const snap = await waiting;
	assert.equal(snap.matched, true);
	assert.ok(Date.now() - t0 < 3_000);
	assert.match(snap.stdout, /compilando[\s\S]*ready on port 3000/);

	const re = m.poll(job.id, { out: snap.nextOut, waitMs: 20_000, until: "/tests?: +[0-9]+ passed/i" });
	setTimeout(() => children[0].stderr.emit("data", Buffer.from("Tests: 12 passed\n")), 50);
	assert.equal((await re).matched, true);
});

test("poll com until sem casar espera o prazo e devolve matched false; fim do job também devolve", async () => {
	const { m, children } = await fakeManager();
	const job = await m.start({ cmd: "dev" });
	const miss = await m.poll(job.id, { waitMs: 300, until: "nunca" });
	assert.equal(miss.matched, false);
	assert.equal(miss.running, true);
	const ending = m.poll(job.id, { waitMs: 20_000, until: "nunca" });
	setTimeout(() => children[0].emit("close", 1, null), 50);
	const done = await ending;
	assert.equal(done.matched, false);
	assert.equal(done.running, false);
	assert.equal(done.exitCode, 1);
});

test("compileUntil rejeita regex inválida e condição enorme", async () => {
	const { compileUntil } = await import("../server/exec-jobs.mjs");
	assert.throws(() => compileUntil("/(/"), ExecError);
	assert.throws(() => compileUntil("x".repeat(400)), ExecError);
	assert.equal(compileUntil("a/b")("xa/by"), true);
	assert.equal(compileUntil(""), null);
});

test("saída acima de 30KB também vai para /workspace/.agent/output/<job>.txt (completa); abaixo disso nada é gravado", async () => {
	const { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const ws = mkdtempSync(join(os.tmpdir(), "spill-"));
	mkdirSync(join(ws, ".git"));
	writeFileSync(join(ws, ".git", "HEAD"), "ref");
	const { m, children } = await fakeManager({ workspace: ws, confine: async () => ws });
	const small = await m.start({ cmd: "a" });
	children[0].stdout.emit("data", Buffer.from("a".repeat(1_000)));
	assert.equal(m.snapshot(small).spillPath, undefined);
	assert.equal(existsSync(join(ws, ".agent", "output")), false);

	const big = await m.start({ cmd: "b" });
	children[1].stdout.emit("data", Buffer.from("b".repeat(20_000)));
	assert.equal(m.snapshot(big).spillPath, undefined);
	children[1].stderr.emit("data", Buffer.from("c".repeat(20_000)));
	const snap = m.snapshot(big);
	assert.equal(snap.spillPath, join(ws, ".agent", "output", big.id + ".txt"));
	children[1].stdout.emit("data", Buffer.from("FIM"));
	const file = readFileSync(snap.spillPath, "utf8");
	assert.equal(file, "b".repeat(20_000) + "c".repeat(20_000) + "FIM");
	// .agent/ fica fora do git pelo exclude local; o .gitignore do repo não é tocado.
	assert.match(readFileSync(join(ws, ".git", "info", "exclude"), "utf8"), /^\.agent\/$/m);
	assert.equal(existsSync(join(ws, ".gitignore")), false);
	// Idempotente: um segundo spill não duplica a linha.
	const big2 = await m.start({ cmd: "d" });
	children[2].stdout.emit("data", Buffer.from("d".repeat(31_000)));
	assert.ok(m.snapshot(big2).spillPath);
	assert.equal(readFileSync(join(ws, ".git", "info", "exclude"), "utf8").split(".agent/").length, 2);
});

test("segredos são redigidos também no arquivo de saída", async () => {
	const { mkdtempSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const ws = mkdtempSync(join(os.tmpdir(), "spill-"));
	const { m, children } = await fakeManager({ workspace: ws, confine: async () => ws });
	const job = await m.start({ cmd: "x", env: { GH_TOKEN: "ghp_topsecret_value" } });
	children[0].stdout.emit("data", Buffer.from("ghp_topsecret_value " + "z".repeat(31_000)));
	const text = readFileSync(m.snapshot(job).spillPath, "utf8");
	assert.ok(!text.includes("ghp_topsecret_value"));
	assert.ok(text.startsWith("*** "));
});

test("arquivos de saída com mais de 7 dias são apagados ao iniciar; os recentes ficam", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } = await import("node:fs");
	const { join } = await import("node:path");
	const ws = mkdtempSync(join(os.tmpdir(), "spill-"));
	const dir = join(ws, ".agent", "output");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "velho.txt"), "x");
	writeFileSync(join(dir, "novo.txt"), "y");
	const old = new Date(Date.now() - 8 * 24 * 3_600_000);
	utimesSync(join(dir, "velho.txt"), old, old);
	await fakeManager({ workspace: ws, confine: async () => ws });
	assert.equal(existsSync(join(dir, "velho.txt")), false);
	assert.equal(existsSync(join(dir, "novo.txt")), true);
});

// ----- estado persistente do shell (cwd e variáveis exportadas entre chamadas) -----

async function stateManager() {
	const { mkdtempSync, realpathSync } = await import("node:fs");
	const { join } = await import("node:path");
	const ws = realpathSync(mkdtempSync(join(os.tmpdir(), "shellstate-")));
	const m = createExecManager({ workspace: ws, home: ws, confine: async (p) => (typeof p === "string" ? p : ws) });
	return { m, ws };
}

test("cd persiste entre chamadas de shell e o resultado traz o cwd final", { skip }, async () => {
	const { m, ws } = await stateManager();
	const first = await m.run({ cmd: "mkdir -p sub/dir && cd sub/dir" });
	assert.equal(first.exitCode, 0);
	assert.equal(first.endCwd, `${ws}/sub/dir`);
	const second = await m.run({ cmd: "pwd" });
	assert.equal(second.stdout.trim(), `${ws}/sub/dir`);
	assert.equal(second.endCwd, `${ws}/sub/dir`);
});

test("variáveis exportadas persistem, o código de saída é preservado e cwd explícito vence o salvo", { skip }, async () => {
	const { m, ws } = await stateManager();
	const first = await m.run({ cmd: "export FOO='a b' ; export MULTI=$'l1\\nl2'; mkdir -p sub && cd sub; exit 7" });
	assert.equal(first.exitCode, 7);
	const second = await m.run({ cmd: 'echo "$FOO|$MULTI"; pwd' });
	assert.equal(second.stdout, `a b|l1\nl2\n${ws}/sub\n`);
	const third = await m.run({ cmd: "pwd", cwd: ws });
	assert.equal(third.stdout.trim(), ws);
});

test("segredos injetados e variáveis com nome de segredo nunca vão para o arquivo de estado", { skip }, async () => {
	const { readFileSync, readdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { m, ws } = await stateManager();
	await m.run({ cmd: "export KEEP=1 OTHER_TOKEN=zzzzzz_secret_value; true", env: { GH_TOKEN: "ghp_topsecret_value", PLAIN_INJECTED: "inj" } });
	const dir = join(ws, ".agent", "shell-state");
	for (const name of readdirSync(dir)) {
		const text = readFileSync(join(dir, name), "utf8");
		assert.ok(!text.includes("ghp_topsecret_value"), name);
		assert.ok(!text.includes("zzzzzz_secret_value"), name);
		assert.ok(!text.includes("PLAIN_INJECTED"), name);
	}
	const next = await m.run({ cmd: 'echo "$KEEP|${GH_TOKEN:-vazio}|${OTHER_TOKEN:-vazio}"' });
	assert.equal(next.stdout.trim(), "1|vazio|vazio");
});

test("cwd salvo que não existe mais volta para a raiz do workspace", { skip }, async () => {
	const { rmSync } = await import("node:fs");
	const { m, ws } = await stateManager();
	await m.run({ cmd: "mkdir gone && cd gone" });
	rmSync(`${ws}/gone`, { recursive: true });
	const r = await m.run({ cmd: "pwd" });
	assert.equal(r.exitCode, 0);
	assert.equal(r.stdout.trim(), ws);
	assert.equal(r.endCwd, ws);
});

test("job em segundo plano começa no cwd salvo, mas não grava estado ao terminar", { skip }, async () => {
	const { m, ws } = await stateManager();
	await m.run({ cmd: "mkdir -p bg && cd bg" });
	const job = await m.start({ cmd: "pwd; cd /tmp; export BGVAR=1" }, { background: true });
	await waitEnded(job);
	assert.equal(m.snapshot(job).stdout.trim(), `${ws}/bg`);
	const r = await m.run({ cmd: 'pwd; echo "${BGVAR:-vazio}"' });
	assert.equal(r.stdout, `${ws}/bg\nvazio\n`);
});
