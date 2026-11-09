/**
 * Cofre do v4 (F9) com db falso e a cripto REAL (`@workspace/db/vault-crypto`, chave de teste): o valor só sai de `resolveSecret`,
 * a senha só de `useLogin`, outro dono nunca lê, e o cartão de pedido leva só nomes. Sem rede nem banco.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/vault.test.ts`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { UserSecretMeta, UserSecretRow } from "@workspace/db";
import { itemAad, newDataKey, openItem, sealItem, unwrapDataKey, wrapDataKey } from "@workspace/db/vault-crypto";
import type { ComputerUseEvent } from "@workspace/shared";
import { createV4LoginSource, createV4SecretRequests, createV4Vault, createV4VaultBackend, type V4VaultDeps } from "./vault.js";

const SECRET = "sk_live_TESTE_nao_vaze_9f3a";
const PASSWORD = "Senha!Teste#Forte-4821";
const TOTP = "JBSWY3DPEHPK3PXP";
const CPF = "123.456.789-09";
const MASTER = randomBytes(32);

function world() {
	const dataKeys = new Map<string, Buffer>();
	const wrappedKeys = new Map<string, string>();
	const rows: UserSecretRow[] = [];
	const calls: string[] = [];
	const audits: Array<{ userId: string; secretId: string; action: string; detail?: string; botId?: string; botName?: string; conversationId?: string }> = [];
	const intents: unknown[] = [];
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const add = (userId: string, input: { id: string; name: string; kind: "secret" | "login"; label?: string; siteUrl?: string; domain?: string; username?: string; payload: object; description?: string }) => {
		if (!wrappedKeys.has(userId)) {
			const key = newDataKey();
			dataKeys.set(userId, key);
			wrappedKeys.set(userId, wrapDataKey(key, MASTER));
		}
		rows.push({
			id: input.id,
			userId,
			kind: input.kind,
			name: input.name,
			label: input.label ?? "",
			description: input.description ?? "",
			siteUrl: input.siteUrl ?? null,
			domain: input.domain ?? null,
			username: input.username ?? null,
			valueEnc: sealItem(dataKeys.get(userId)!, itemAad(userId, input.id), input.payload),
			createdAt: new Date(0),
			updatedAt: new Date(0),
			lastUsedAt: null,
			alwaysBots: [],
		});
	};
	add("a", { id: "vs_1", name: "stripe-key", kind: "secret", description: "Stripe", payload: { value: SECRET } });
	add("a", { id: "vs_2", name: "banco", kind: "login", label: "Banco", siteUrl: "https://banco.example/login", domain: "banco.example", username: "dono@exemplo.test", payload: { password: PASSWORD, totp: TOTP } });
	add("b", { id: "vs_3", name: "stripe-key", kind: "secret", payload: { value: "valor-do-b" } });
	// Login novo (F9): campos declarados pela IA dentro do selado; sem `username` em claro.
	add("a", {
		id: "vs_4",
		name: "plataforma",
		kind: "login",
		label: "plataforma.example",
		siteUrl: "https://plataforma.example",
		domain: "plataforma.example",
		payload: { fields: [{ key: "nome", label: "Nome", secret: false, value: "Ana Souza" }, { key: "cpf", label: "CPF", secret: true, value: CPF }, { key: "senha", label: "Senha", secret: true, value: PASSWORD }] },
	});

	const deps: V4VaultDeps = {
		listMeta: async (userId) => {
			calls.push(`listMeta:${userId}`);
			return rows.filter((r) => r.userId === userId).map(({ valueEnc: _enc, userId: _u, ...meta }) => meta as UserSecretMeta);
		},
		listRows: async (userId) => rows.filter((r) => r.userId === userId),
		getByName: async (userId, name) => rows.find((r) => r.userId === userId && r.name === name) ?? null,
		getKey: async (userId) => wrappedKeys.get(userId) ?? null,
		touch: async (userId, id) => void calls.push(`touch:${userId}:${id}`),
		audit: async (userId, secretId, entry) => void audits.push({ userId, secretId, action: entry.action, ...(entry.detail && { detail: entry.detail }), ...(entry.botId && { botId: entry.botId }), ...(entry.botName && { botName: entry.botName }), ...(entry.conversationId && { conversationId: entry.conversationId }) }),
		unwrap: (wrapped) => unwrapDataKey(wrapped, MASTER),
		open: (key, userId, row) => openItem(key, itemAad(userId, row.id), row.valueEnc),
		saveIntent: async (input) => void intents.push(input),
		persistCard: async (conversationId, event) => void cards.push({ conversationId, event }),
	};
	return { deps, calls, audits, intents, cards, rows, wrappedKeys };
}

test("listHandles: nomes, tipo, site e usuário do dono; nunca valor, senha nem o conteúdo selado", async () => {
	const w = world();
	const backend = createV4VaultBackend(w.deps);
	const handles = await backend.listHandles("a");
	assert.deepEqual(handles, [
		{ id: "stripe-key", label: "stripe-key", kind: "secret", description: "Stripe" },
		// Login antigo: usuário (claro) e senha lidos como os campos `username` e `password`.
		{ id: "banco", label: "Banco", kind: "login", site: "banco.example", username: "dono@exemplo.test", fields: [{ key: "username", label: "Usuário", secret: false }, { key: "password", label: "Senha", secret: true }] },
		// Login novo: só chave, rótulo e se é secreto.
		{ id: "plataforma", label: "plataforma.example", kind: "login", site: "plataforma.example", fields: [{ key: "nome", label: "Nome", secret: false }, { key: "cpf", label: "CPF", secret: true }, { key: "senha", label: "Senha", secret: true }] },
	]);
	const text = JSON.stringify(handles);
	for (const secret of [SECRET, PASSWORD, TOTP, "valor-do-b", CPF, "Ana Souza"]) assert.ok(!text.includes(secret));
	assert.deepEqual(await backend.listHandles("ninguem"), []);
	assert.deepEqual(w.audits, []);
});

test("resolveSecret: o valor do segredo simples do dono, com uso auditado; outro dono, login e inexistente dão null", async () => {
	const w = world();
	const backend = createV4VaultBackend(w.deps);
	assert.equal(await backend.resolveSecret("a", "stripe-key"), SECRET);
	assert.equal(await backend.resolveSecret("b", "stripe-key"), "valor-do-b");
	assert.equal(await backend.resolveSecret("b", "banco"), null); // o login é do A
	assert.equal(await backend.resolveSecret("a", "banco"), null); // senha de login nunca sai por aqui
	assert.equal(await backend.resolveSecret("a", "nao-existe"), null);
	assert.equal(await backend.resolveSecret("c", "stripe-key"), null);
	assert.deepEqual(w.audits.map((a) => [a.userId, a.secretId, a.action, a.detail]), [
		["a", "vs_1", "used", "agent_v4"],
		["b", "vs_3", "used", "agent_v4"],
	]);
});

test("resolveSecret: a auditoria de uso grava o bot, o nome e a conversa do run (sem o valor)", async () => {
	const w = world();
	const backend = createV4VaultBackend(w.deps, { botId: "bot_1", botName: "Ana", conversationId: "conv_1" });
	assert.equal(await backend.resolveSecret("a", "stripe-key"), SECRET);
	assert.equal(w.audits.length, 1);
	assert.equal(w.audits[0]!.botId, "bot_1");
	assert.equal(w.audits[0]!.botName, "Ana");
	assert.equal(w.audits[0]!.conversationId, "conv_1");
	assert.ok(!JSON.stringify(w.audits).includes(SECRET));
});

test("item copiado para a linha de outro dono não abre (o AAD amarra dono e id)", async () => {
	const w = world();
	// Mesmo ciphertext do A numa linha do B: o envelope do B não o abre.
	const stolen = w.rows.find((r) => r.id === "vs_1")!;
	w.rows.push({ ...stolen, id: "vs_9", userId: "b", name: "roubado" });
	const backend = createV4VaultBackend(w.deps);
	await assert.rejects(backend.resolveSecret("b", "roubado"), /could not be opened/);
});

test("cofre que não abre (chave do servidor trocada): erro fixo, sem nenhum dado", async () => {
	const w = world();
	const backend = createV4VaultBackend({ ...w.deps, unwrap: () => { throw new Error(`master ${MASTER.toString("base64")} errada`); } });
	await assert.rejects(backend.resolveSecret("a", "stripe-key"), (error: Error) => {
		assert.match(error.message, /could not be opened/);
		assert.ok(!error.message.includes(MASTER.toString("base64")));
		return true;
	});
});

test("useLogin (login antigo): username e password só do login do dono, só as chaves pedidas, com uso auditado (sem o valor no registro)", async () => {
	const w = world();
	const source = createV4LoginSource(w.deps);
	const login = await source.getLogin("a", "banco");
	assert.ok(login);
	assert.equal(login.siteUrl, "https://banco.example/login");
	assert.deepEqual(await source.useLogin("a", login, ["username", "password"]), {
		saved: ["username", "password"],
		fields: [{ key: "username", secret: false, value: "dono@exemplo.test" }, { key: "password", secret: true, value: PASSWORD }],
	});
	assert.deepEqual((await source.useLogin("a", login, ["password"])).fields, [{ key: "password", secret: true, value: PASSWORD }]);
	assert.equal(w.audits.length, 2);
	assert.match(w.audits[0]!.detail ?? "", /^login_fill: username, password$/);
	assert.ok(!JSON.stringify(w.audits).includes(PASSWORD));
});

test("useLogin (login novo): os campos declarados por chave; chave que não existe não vem nem gera uso; só nomes no registro", async () => {
	const w = world();
	const source = createV4LoginSource(w.deps);
	const login = (await source.getLogin("a", "plataforma"))!;
	const use = await source.useLogin("a", login, ["cpf", "nome", "email"]);
	assert.deepEqual(use.saved, ["nome", "cpf", "senha"]);
	assert.deepEqual(use.fields, [{ key: "cpf", secret: true, value: CPF }, { key: "nome", secret: false, value: "Ana Souza" }]);
	assert.match(w.audits[0]!.detail ?? "", /^login_fill: cpf, nome$/);
	assert.ok(!JSON.stringify(w.audits).includes(CPF));
	const nothing = await source.useLogin("a", login, ["email"]);
	assert.deepEqual(nothing.fields, []);
	assert.equal(w.audits.length, 1);
});

test("getLogin: login de outro dono e segredo simples são 'não achei'; useLogin com registro forjado de outro dono recusa", async () => {
	const w = world();
	const source = createV4LoginSource(w.deps);
	assert.equal(await source.getLogin("b", "banco"), null);
	assert.equal(await source.getLogin("a", "stripe-key"), null);
	const real = (await source.getLogin("a", "banco"))!;
	await assert.rejects(source.useLogin("b", real, ["password"]), /not in this owner's vault/);
	assert.equal(await source.getLogin("b", "plataforma"), null);
	await assert.rejects(source.useLogin("a", { ...real, id: "vs_outro" }, ["password"]), /not in this owner's vault/);
	assert.deepEqual(w.audits, []);
});

test("cartão de pedido: só nomes e motivo; intenção gravada para o dono; emitido e persistido; sem valor", async () => {
	const w = world();
	const emitted: ComputerUseEvent[] = [];
	const requests = createV4SecretRequests({ scope: { conversationId: "conv-1", botId: "bot-1", emit: (e) => void emitted.push(e) }, deps: w.deps });
	await requests.ask("a", "run-7", { names: ["openai-key", "stripe-key"], reason: "Para chamar a API." });
	assert.equal(w.intents.length, 1);
	assert.deepEqual(w.intents[0], {
		userId: "a",
		conversationId: "conv-1",
		payload: { kind: "confirm", action: "request-secrets", confirmId: "confirm-run-7", botId: "bot-1", secretsRequest: { environmentId: "vault", repo: "", names: ["openai-key", "stripe-key"] } },
		ttlMs: 3_600_000,
	});
	assert.equal(emitted.length, 1);
	const card = emitted[0] as Extract<ComputerUseEvent, { type: "confirm" }>;
	assert.equal(card.type, "confirm");
	assert.equal(card.confirmId, "confirm-run-7");
	assert.match(card.title, /openai-key, stripe-key/);
	assert.deepEqual(w.cards, [{ conversationId: "conv-1", event: card }]);
	assert.ok(!JSON.stringify({ intents: w.intents, emitted, cards: w.cards }).includes(SECRET));
	await assert.rejects(requests.ask("a", "run-7", { names: ["x"], reason: "y" }), /already shown/);
});

test("cartão de pedido sem conversa falha com o motivo; createV4Vault nem oferece o pedido sem conversa", async () => {
	const w = world();
	const requests = createV4SecretRequests({ scope: { conversationId: null, emit: () => undefined }, deps: w.deps });
	await assert.rejects(requests.ask("a", "run-1", { names: ["x"], reason: "y" }), /no conversation/);
	assert.equal(createV4Vault({ scope: { conversationId: null, emit: () => undefined }, deps: w.deps }).requests, undefined);
	assert.ok(createV4Vault({ scope: { conversationId: "c", emit: () => undefined }, deps: w.deps }).requests);
	assert.deepEqual(w.intents, []);
});

test("falha ao gravar o cartão na conversa não impede o aviso ao vivo e o log não leva o motivo do erro", async () => {
	const w = world();
	const logs: string[] = [];
	const emitted: ComputerUseEvent[] = [];
	const requests = createV4SecretRequests({ scope: { conversationId: "c", emit: (e) => void emitted.push(e), log: (m) => void logs.push(m) }, deps: { ...w.deps, persistCard: async () => { throw new Error(`db: ${SECRET}`); } } });
	await requests.ask("a", "run-1", { names: ["x"], reason: "y" });
	assert.equal(emitted.length, 1);
	assert.ok(!logs.join("\n").includes(SECRET));
});

test("cartão de pedido de LOGIN: site, campos declarados (chave, rótulo, secreto) no evento e na intenção; nenhum valor", async () => {
	const w = world();
	const emitted: ComputerUseEvent[] = [];
	const requests = createV4SecretRequests({ scope: { conversationId: "conv-1", botId: "bot-1", emit: (e) => void emitted.push(e) }, deps: w.deps });
	const fields = [{ key: "nome", label: "Nome", secret: false }, { key: "cpf", label: "CPF", secret: true }, { key: "senha", label: "Senha", secret: true }];
	await requests.ask("a", "run-9", { names: ["nome", "cpf", "senha"], reason: "Entrar na plataforma.", login: { site: "plataforma.example", name: "plataforma", fields } });
	const card = emitted[0] as Extract<ComputerUseEvent, { type: "confirm" }>;
	assert.match(card.title, /login de plataforma\.example/);
	assert.deepEqual(card.secretsRequest, { environmentId: "vault", repo: "", names: ["nome", "cpf", "senha"], reason: "Entrar na plataforma.", login: { site: "plataforma.example", name: "plataforma", fields } });
	assert.deepEqual((w.intents[0] as { payload: { secretsRequest: unknown } }).payload.secretsRequest, { environmentId: "vault", repo: "", names: ["nome", "cpf", "senha"], login: { site: "plataforma.example", name: "plataforma", fields } });
	assert.deepEqual(w.cards, [{ conversationId: "conv-1", event: card }]);
	assert.ok(!JSON.stringify({ emitted, intents: w.intents }).includes(CPF));
});
