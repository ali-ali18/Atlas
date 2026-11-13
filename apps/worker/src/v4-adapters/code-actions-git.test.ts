/**
 * D1/D2/D3 da auditoria F9 com git DE VERDADE: um repositório hostil (hook, fsmonitor, origin reapontado) não recebe o token no
 * push nem no fetch, o push vai para a URL da sessão e a lista do stage traz o nome com acento sem aspas.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/code-actions-git.test.ts`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { classifyCommitPaths } from "@workspace/shared";
import { GIT_SCRIPTS } from "./code-actions.js";

const TOKEN = "ghp_" + "Z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2";
const root = mkdtempSync(join(tmpdir(), "atlas-git-"));
after(() => rmSync(root, { recursive: true, force: true }));

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

/** Ambiente isolado: sem config do sistema/usuário, com `https://github.com/acme/loja.git` redirecionado para um repositório local. */
function world() {
	const dir = mkdtempSync(join(root, "w-"));
	const bare = join(dir, "github.git");
	const repo = join(dir, "loja");
	const leak = join(dir, "leak");
	mkdirSync(leak);
	const globalConfig = join(dir, "gitconfig");
	writeFileSync(globalConfig, `[user]\n\tname = t\n\temail = t@example.test\n[init]\n\tdefaultBranch = main\n[url "${bare}"]\n\tinsteadOf = https://github.com/acme/loja.git\n`);
	const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
	const sh = (cmd: string, extra: Record<string, string> = {}, cwd = dir) => spawnSync("bash", ["-c", cmd], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
	assert.equal(sh(`git init -q --bare "${bare}" && git init -q "${repo}" && cd "${repo}" && echo a > a.txt && git add a.txt && git commit -q -m um && git switch -q -c fix/preco`).status, 0);
	// Repositório hostil: o que um postinstall poderia gravar no .git/config.
	const hooks = join(dir, "hooks");
	mkdirSync(hooks);
	for (const name of ["pre-push", "pre-commit", "reference-transaction"]) {
		writeFileSync(join(hooks, name), `#!/bin/sh\nprintenv GH_TOKEN > "${leak}/hook-${name}"\nexit 0\n`);
		chmodSync(join(hooks, name), 0o755);
	}
	writeFileSync(join(dir, "fsmon.sh"), `#!/bin/sh\nprintenv GH_TOKEN > "${leak}/fsmonitor"\nexit 0\n`);
	chmodSync(join(dir, "fsmon.sh"), 0o755);
	const cfg = (k: string, v: string) => assert.equal(sh(`git config "${k}" "${v}"`, {}, repo).status, 0);
	cfg("core.hooksPath", hooks);
	cfg("core.fsmonitor", join(dir, "fsmon.sh"));
	// `origin` reapontado para outro repositório (local, para o push antigo chegar até o hook).
	const evil = join(dir, "evil.git");
	assert.equal(sh(`git init -q --bare "${evil}"`).status, 0);
	cfg("remote.origin.url", evil);
	cfg("remote.origin.pushurl", evil);
	const run = (script: string, extra: Record<string, string>) => sh(script, { DEV_REPO_DIR: repo, GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, DEV_REMOTE_URL: "https://github.com/acme/loja.git", ...extra });
	const leaked = () => ["hook-pre-push", "hook-pre-commit", "hook-reference-transaction", "fsmonitor"].filter((f) => existsSync(join(leak, f)));
	return { dir, bare, evil, repo, sh, run, leaked };
}

test("controle: o push antigo (`git push origin`) vazava o token para o hook do repositório hostil", { skip: !gitAvailable }, () => {
	const w = world();
	w.sh('cd "$DEV_REPO_DIR" && git push -u origin "refs/heads/$DEV_HEAD:refs/heads/$DEV_HEAD" 2>&1', { DEV_REPO_DIR: w.repo, GH_TOKEN: TOKEN, DEV_HEAD: "fix/preco" });
	assert.ok(w.leaked().includes("hook-pre-push"), "o cenário hostil precisa funcionar, senão o teste abaixo não prova nada");
});

test("push: vai para a URL da sessão (não para o origin reapontado), sem hook nem fsmonitor e sem o token vazar", { skip: !gitAvailable }, () => {
	const w = world();
	const out = w.run(GIT_SCRIPTS.PUSH_SCRIPT, { DEV_HEAD: "fix/preco" });
	assert.equal(out.status, 0, out.stdout + out.stderr);
	assert.deepEqual(w.leaked(), []);
	const remote = w.sh(`git --git-dir="${w.bare}" rev-parse refs/heads/fix/preco`);
	assert.equal(remote.status, 0, "a branch chegou no repositório da sessão");
	assert.equal(remote.stdout.trim(), w.sh("git rev-parse HEAD", {}, w.repo).stdout.trim());
	assert.notEqual(w.sh(`git --git-dir="${w.evil}" rev-parse refs/heads/fix/preco`).status, 0, "nada foi para o origin reapontado");
});

test("fetch e ls-remote do pr_prepare: mesmo repositório hostil, sem vazar o token e olhando a URL da sessão", { skip: !gitAvailable }, () => {
	const w = world();
	assert.equal(w.run(GIT_SCRIPTS.PUSH_SCRIPT, { DEV_HEAD: "fix/preco" }).status, 0);
	rmSync(join(w.dir, "leak"), { recursive: true, force: true });
	mkdirSync(join(w.dir, "leak"));
	const out = w.run(GIT_SCRIPTS.PR_NET_SCRIPT, { DEV_BASE: "fix/preco", DEV_HEAD: "fix/preco" });
	assert.equal(out.status, 0, out.stdout + out.stderr);
	assert.deepEqual(w.leaked(), []);
	assert.match(out.stdout, /^remote=[0-9a-f]{40}$/m);
	assert.ok(!out.stdout.includes("fetch=failed"), out.stdout);
});

test("stage: nome com acento sai sem aspas e é pego pelo portão de segredo; o push check lista os arquivos dos commits à frente (git add -f .env)", { skip: !gitAvailable }, () => {
	const w = world();
	assert.equal(w.sh('mkdir -p dé && echo K=1 > dé/.env && echo x > ok.txt && echo -----BEGIN > chave.pem', {}, w.repo).status, 0);
	const staged = w.run(GIT_SCRIPTS.STAGE_SCRIPT, { DEV_BRANCH: "", DEV_PATHS: "" });
	assert.equal(staged.status, 0, staged.stderr);
	const names = staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	assert.ok(names.includes("dé/.env"), JSON.stringify(names));
	assert.deepEqual(classifyCommitPaths(names).secrets.sort(), ["chave.pem", "dé/.env"]);
	// Segredo já comitado por outro caminho (code_shell com `git add -f`): o push check o enxerga.
	assert.equal(w.sh('git commit -q -m x', {}, w.repo).status, 0);
	const ahead = w.run(GIT_SCRIPTS.PUSH_CHECK_SCRIPT, {});
	assert.equal(ahead.status, 0, ahead.stderr);
	assert.deepEqual(classifyCommitPaths(ahead.stdout.split("\n")).secrets.sort(), ["chave.pem", "dé/.env"]);
});
