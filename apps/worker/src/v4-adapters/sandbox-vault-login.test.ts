/**
 * Tratador `vault.login_fill` (F9) com VM e cofre falsos: só digita na página do site salvo (https), reconfere a aba a cada campo,
 * lê o valor só no worker e nunca o devolve (nem no erro), e roda pela porta `Sandbox` real do worker (escopo do dono do run).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/sandbox-vault-login.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { VAULT_KINDS } from "@workspace/agent";
import type { SandboxManager } from "@workspace/sandbox";
import { LOGIN_FIELD_SELECTORS } from "@workspace/shared";
import { createV4Sandbox, type V4SandboxDeps } from "./sandbox.js";
import { createLoginFillHandler } from "./sandbox-vault-login.js";
import type { LoginRecord, LoginSource } from "./vault.js";

const PASSWORD = "Senha!Teste#Forte-4821";
const USERNAME = "dono@exemplo.test";
const BANK: LoginRecord = { id: "vs_2", name: "banco", siteUrl: "https://banco.example/login", domain: "banco.example" };

type Typed = { sessionId: string; selector?: string; text: string; submit?: boolean; guard?: { kind: string; origin?: string } };

function world(opts: { urls?: string[]; login?: LoginRecord | null; logins?: LoginRecord[]; typeFails?: (typed: Typed) => Error | { ok: false } | null } = {}) {
	const urls = [...(opts.urls ?? ["https://banco.example/login"])];
	const typed: Typed[] = [];
	const used: Array<{ userId: string; name: string; fields: string[] }> = [];
	let urlCalls = 0;
	const source: LoginSource = {
		getLogin: async (userId, name) => (userId === "a" && name === "banco" ? (opts.login === undefined ? BANK : opts.login) : null),
		listLogins: async (userId) => (userId === "a" ? (opts.logins ?? [BANK]) : []),
		useLogin: async (userId, login, fields) => {
			used.push({ userId, name: login.name, fields: [...fields] });
			return { ...(fields.includes("username") && { username: USERNAME }), ...(fields.includes("password") && { password: PASSWORD }) };
		},
	};
	const manager = {
		async execBrowserText() {
			const url = urls[Math.min(urlCalls++, urls.length - 1)]!;
			return { url, title: "t", text: "" };
		},
		async execBrowserType(sessionId: string, params: Omit<Typed, "sessionId">) {
			const entry = { sessionId, ...params };
			const failure = opts.typeFails?.(entry) ?? null;
			if (failure instanceof Error) throw failure;
			if (failure) return failure;
			typed.push(entry);
			return { ok: true };
		},
	} as unknown as SandboxManager;
	const handler = createLoginFillHandler(source);
	const run = (params: unknown, userId = "a") => handler({ userId, runId: "run-1", sessionId: "s-1", manager }, params);
	return { run, typed, used };
}

const PARAMS = { login: "banco", fields: ["username", "password"], submit: false };

test("página do site salvo: digita usuário e senha com o guarda da VM (origem e tipo do campo) e devolve só nomes de campo", async () => {
	const w = world();
	const out = await w.run(PARAMS);
	assert.deepEqual(out, { ok: true, data: { login: "banco", filled: ["username", "password"], site: "banco.example", submitted: false } });
	assert.deepEqual(w.typed, [
		{ sessionId: "s-1", selector: LOGIN_FIELD_SELECTORS.username, text: USERNAME, submit: false, guard: { kind: "username", origin: "https://banco.example" } },
		{ sessionId: "s-1", selector: LOGIN_FIELD_SELECTORS.password, text: PASSWORD, submit: false, guard: { kind: "password", origin: "https://banco.example" } },
	]);
	assert.ok(!JSON.stringify(out).includes(PASSWORD) && !JSON.stringify(out).includes(USERNAME));
});

test("submit: só o último campo envia, e o resultado diz o domínio de chegada (nunca título nem texto da página)", async () => {
	const w = world({ urls: ["https://banco.example/login", "https://banco.example/login", "https://banco.example/login", "https://banco.example/conta"] });
	const out = await w.run({ ...PARAMS, submit: true });
	assert.deepEqual(out, { ok: true, data: { login: "banco", filled: ["username", "password"], site: "banco.example", submitted: true, landedHost: "banco.example" } });
	assert.deepEqual(w.typed.map((t) => t.submit), [false, true]);
});

test("só a senha (login em duas telas) e seletor do usuário informado pelo modelo", async () => {
	const w = world();
	assert.equal((await w.run({ login: "banco", fields: ["password"], submit: false })).ok, true);
	assert.deepEqual(w.used.at(-1)?.fields, ["password"]);
	const w2 = world();
	await w2.run({ login: "banco", fields: ["username"], submit: false, usernameSelector: "#cpf" });
	assert.equal(w2.typed[0]?.selector, "#cpf");
});

test("página de outro site (phishing), http ou subdomínio alheio: recusa ANTES de ler o cofre, nada digitado", async () => {
	for (const url of ["https://banco.example.evil.test/login", "http://banco.example/login", "https://evil.test/", "https://sites.banco.example/x"]) {
		const w = world({ urls: [url] });
		const out = await w.run(PARAMS);
		assert.equal(out.ok, false, url);
		assert.match((out as { error: string }).error, /Refused: the current page/);
		assert.deepEqual(w.used, [], url);
		assert.deepEqual(w.typed, [], url);
	}
});

test("a aba muda de site entre o usuário e a senha: para, a senha não é digitada e o erro diz o que já foi preenchido", async () => {
	const w = world({ urls: ["https://banco.example/login", "https://banco.example/login", "https://evil.test/"] });
	const out = (await w.run(PARAMS)) as { ok: false; error: string };
	assert.equal(out.ok, false);
	assert.match(out.error, /moved to another site \(evil\.test\) before the password/);
	assert.match(out.error, /Already filled: username/);
	assert.deepEqual(w.typed.map((t) => t.guard?.kind), ["username"]);
	assert.ok(!out.error.includes(PASSWORD));
});

test("login sem site salvo, inexistente ou de outro dono: nada é lido nem digitado", async () => {
	const noSite = world({ login: { ...BANK, siteUrl: null, domain: null } });
	assert.match(((await noSite.run(PARAMS)) as { error: string }).error, /no saved site/);
	assert.deepEqual(noSite.used, []);
	const w = world();
	assert.equal((await w.run(PARAMS, "b")).ok, false); // dono B não tem "banco"
	assert.equal((await w.run({ ...PARAMS, login: "outro" })).ok, false);
	assert.deepEqual(w.used, []);
	assert.deepEqual(w.typed, []);
});

test("parâmetros inválidos (totp, campo extra, nome vazio) são recusados sem tocar no cofre", async () => {
	const w = world();
	for (const params of [{ ...PARAMS, fields: ["totp"] }, { ...PARAMS, password: "x" }, { ...PARAMS, login: "" }, null, "texto"]) {
		const out = await w.run(params);
		assert.equal(out.ok, false);
	}
	assert.deepEqual(w.used, []);
});

test("a VM recusa o campo (formulário para outro site) ou diz que não achou: erro com o motivo, sem o valor", async () => {
	const refused = world({ typeFails: (t) => (t.guard?.kind === "password" ? new Error(`Recusado: o formulário envia a senha ${PASSWORD} para outro site.`) : null) });
	const out = (await refused.run(PARAMS)) as { ok: false; error: string };
	assert.equal(out.ok, false);
	assert.match(out.error, /did not type the password/);
	assert.ok(!out.error.includes(PASSWORD));
	assert.match(out.error, /Already filled: username/);
	const missing = world({ typeFails: (t) => (t.guard?.kind === "username" ? { ok: false } : null) });
	assert.match(((await missing.run(PARAMS)) as { error: string }).error, /username field was not found/);
});

test("navegador fora do ar ao ler a página: erro, nada lido do cofre", async () => {
	const handler = createLoginFillHandler({ getLogin: async () => BANK, listLogins: async () => [BANK], useLogin: async () => assert.fail("não deveria ler o cofre") });
	const manager = { execBrowserText: async () => { throw new Error("connection reset"); } } as unknown as SandboxManager;
	const out = await handler({ userId: "a", runId: "r", sessionId: "s", manager }, PARAMS);
	assert.deepEqual(out, { ok: false, error: "The browser page could not be read, so nothing was typed." });
});

test("pela porta Sandbox real do worker: o kind vault.login_fill chega ao tratador do dono do run e a VM de outro dono é recusada", async () => {
	const w = world();
	const handler = createLoginFillHandler({ getLogin: async (userId, name) => (userId === "a" && name === "banco" ? BANK : null), listLogins: async () => [BANK], useLogin: async () => ({ username: USERNAME, password: PASSWORD }) });
	const typed: string[] = [];
	const deps: V4SandboxDeps = {
		createManager: () =>
			({
				resolveSession: async () => ({ sessionId: "s-a" }),
				destroySession: async () => true,
				execBrowserText: async () => ({ url: "https://banco.example/login", title: "", text: "" }),
				execBrowserType: async (_s: string, p: { text: string }) => {
					typed.push(p.text);
					return { ok: true };
				},
			}) as unknown as SandboxManager,
	};
	const sandbox = createV4Sandbox({ scope: { userId: "a", runId: "run-1", conversationId: "conv-1" }, deps, handlers: { [VAULT_KINDS.loginFill]: handler } });
	const ok = await sandbox.run("a", { kind: VAULT_KINDS.loginFill, params: PARAMS });
	assert.equal(ok.ok, true);
	assert.deepEqual(typed, [USERNAME, PASSWORD]);
	assert.ok(!JSON.stringify(ok).includes(PASSWORD));
	const other = await sandbox.run("b", { kind: VAULT_KINDS.loginFill, params: PARAMS });
	assert.equal(other.ok, false);
	assert.equal(typed.length, 2);
	void w;
});

test("o kind vault.login_fill está registrado por padrão na porta Sandbox do worker", async () => {
	const { defaultSandboxHandlers } = await import("./sandbox.js");
	assert.equal(typeof defaultSandboxHandlers[VAULT_KINDS.loginFill], "function");
});

// ---- sem nome: o login é achado pelo site da página atual ----

const NO_NAME = { fields: ["username", "password"], submit: false };
const lojaLogin: LoginRecord = { id: "vs_3", name: "loja", siteUrl: "https://loja.example", domain: "loja.example" };
const painel: LoginRecord = { id: "vs_4", name: "banco-painel", siteUrl: "https://painel.banco.example/entrar", domain: "painel.banco.example" };
const bankTwo: LoginRecord = { id: "vs_5", name: "banco-conjunta", siteUrl: "banco.example", domain: "banco.example" };

test("sem nome: um login do site da página (www, caminho, query e barra final não importam) é usado e digitado", async () => {
	for (const url of ["https://banco.example/login", "https://www.banco.example/entrar?next=/conta", "https://BANCO.example/a/b/"]) {
		const w = world({ urls: [url], logins: [lojaLogin, BANK, painel] });
		const out = await w.run(NO_NAME);
		assert.equal(out.ok, true, url);
		assert.deepEqual(w.used, [{ userId: "a", name: "banco", fields: ["username", "password"] }], url);
		assert.equal((out as { data: { login: string } }).data.login, "banco");
		assert.deepEqual(w.typed.map((t) => t.text), [USERNAME, PASSWORD]);
	}
});

test("sem nome: site salvo com www ou sem esquema casa com a página sem www", async () => {
	const saved: LoginRecord = { id: "vs_6", name: "banco-www", siteUrl: "www.banco.example/", domain: null };
	const w = world({ urls: ["https://banco.example/login"], logins: [saved], login: saved });
	assert.equal((await w.run(NO_NAME)).ok, true);
	assert.equal(w.used[0]?.name, "banco-www");
});

test("sem nome, nenhum candidato: erro honesto com só nome e site dos parecidos; nada lido do cofre nem digitado", async () => {
	const w = world({ urls: ["https://banco.example/login"], logins: [lojaLogin, painel] });
	const out = (await w.run(NO_NAME)) as { ok: false; error: string };
	assert.equal(out.ok, false);
	assert.match(out.error, /No saved login belongs to banco\.example/);
	assert.match(out.error, /"banco-painel" \(painel\.banco\.example\)/);
	assert.ok(!out.error.includes("loja"));
	assert.deepEqual(w.used, []);
	assert.deepEqual(w.typed, []);
	const none = world({ urls: ["https://banco.example/login"], logins: [lojaLogin] });
	assert.match(((await none.run(NO_NAME)) as { error: string }).error, /No saved login has a similar site/);
});

test("sem nome, dois candidatos no mesmo site: pede para escolher pelo nome e lista os dois; nada digitado", async () => {
	const w = world({ urls: ["https://www.banco.example/login"], logins: [BANK, bankTwo, lojaLogin] });
	const out = (await w.run(NO_NAME)) as { ok: false; error: string };
	assert.equal(out.ok, false);
	assert.match(out.error, /More than one saved login belongs to banco\.example/);
	assert.match(out.error, /"banco"/);
	assert.match(out.error, /"banco-conjunta"/);
	assert.match(out.error, /login set to the name/);
	assert.ok(!out.error.includes("loja"));
	assert.deepEqual(w.used, []);
	assert.deepEqual(w.typed, []);
});

test("sem nome, a checagem de segurança continua: página http ou de outro site não digita", async () => {
	const http = world({ urls: ["http://banco.example/login"] });
	const out = (await http.run(NO_NAME)) as { ok: false; error: string };
	assert.equal(out.ok, false);
	assert.match(out.error, /Refused: the current page/);
	assert.deepEqual(http.used, []);
	const evil = world({ urls: ["https://banco.example.evil.test/login"] });
	assert.equal((await evil.run(NO_NAME)).ok, false);
	assert.deepEqual(evil.typed, []);
});

test("sem nome, a aba muda de site entre os campos: para e a senha não é digitada", async () => {
	const w = world({ urls: ["https://banco.example/login", "https://banco.example/login", "https://banco.example/login", "https://evil.test/"] });
	const out = (await w.run(NO_NAME)) as { ok: false; error: string };
	assert.equal(out.ok, false);
	assert.match(out.error, /moved to another site/);
	assert.deepEqual(w.typed.map((t) => t.guard?.kind), ["username"]);
});

test("sem nome: só enxerga os logins do dono do run (dono B não acha o de A) e a página ilegível não digita", async () => {
	const w = world({ urls: ["https://banco.example/login"] });
	const other = (await w.run(NO_NAME, "b")) as { ok: false; error: string };
	assert.equal(other.ok, false);
	assert.match(other.error, /No saved login belongs to/);
	assert.deepEqual(w.used, []);
	const handler = createLoginFillHandler({ getLogin: async () => null, listLogins: async () => assert.fail("não deveria listar"), useLogin: async () => assert.fail("não deveria ler") });
	const manager = { execBrowserText: async () => { throw new Error("down"); } } as unknown as SandboxManager;
	const out = await handler({ userId: "a", runId: "r", sessionId: "s", manager }, NO_NAME);
	assert.equal(out.ok, false);
});
