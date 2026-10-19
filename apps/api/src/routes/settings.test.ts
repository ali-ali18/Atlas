import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { createSettingsRoutes } = await import("./settings.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";
const OWNER_EMAIL = process.env.ATLAS_OWNER_EMAIL!;
const SECRET = "sk-or-v1-segredo-que-nunca-deve-aparecer";

type Row = { userId: string; sandboxAutoStart: boolean; configJson: unknown };

/** Dublê in-memory dos delegates usados por `packages/db/src/settings.ts`. */
function installFakePrisma(rows: Map<string, Row>) {
	const delegates = {
		findUnique: async (args: { where: { userId?: string } }) =>
			(args.where.userId ? rows.get(args.where.userId) : undefined) ?? null,
		upsert: async (args: {
			where: { userId: string };
			create: { userId: string; sandboxAutoStart?: boolean; configJson?: unknown };
			update: { sandboxAutoStart?: boolean; configJson?: unknown };
		}) => {
			const row = rows.get(args.where.userId);
			if (row) {
				if (args.update.sandboxAutoStart !== undefined) row.sandboxAutoStart = args.update.sandboxAutoStart;
				if (args.update.configJson !== undefined) row.configJson = args.update.configJson;
				return row;
			}
			const created: Row = {
				userId: args.create.userId,
				sandboxAutoStart: args.create.sandboxAutoStart ?? true,
				configJson: args.create.configJson ?? null,
			};
			rows.set(created.userId, created);
			return created;
		},
	};
	const original = {
		findUnique: prisma.userSettings.findUnique,
		upsert: prisma.userSettings.upsert,
		userFindUnique: prisma.user.findUnique,
		transaction: prisma.$transaction,
	};
	prisma.userSettings.findUnique = delegates.findUnique as unknown as typeof prisma.userSettings.findUnique;
	prisma.userSettings.upsert = delegates.upsert as unknown as typeof prisma.userSettings.upsert;
	prisma.user.findUnique = (async () => ({ email: "nao-e-o-dono@example.com" })) as unknown as typeof prisma.user.findUnique;
	prisma.$transaction = (async (callback: (tx: unknown) => Promise<unknown>) =>
		callback({ $executeRaw: async () => 0, userSettings: delegates })) as unknown as typeof prisma.$transaction;
	return () => {
		prisma.userSettings.findUnique = original.findUnique;
		prisma.userSettings.upsert = original.upsert;
		prisma.user.findUnique = original.userFindUnique;
		prisma.$transaction = original.transaction;
	};
}

type Deps = Parameters<typeof createSettingsRoutes>[0];
const baseEnv = { OPENROUTER_API_KEY: SECRET } as NodeJS.ProcessEnv;

function appFor(userId: string, email: string, deps: Deps = {}) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, email } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createSettingsRoutes({ env: baseEnv, isKnownModel: async () => true, ...deps }));
	return outer;
}

const patch = (app: Hono<AuthEnv>, body: unknown) =>
	app.request("/v1/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

test("GET sem config: tudo herdado, origem padrão e capabilities sem segredo", async () => {
	const restore = installFakePrisma(new Map());
	try {
		const res = await appFor(USER_A, OWNER_EMAIL).request("/v1/settings");
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.ok(!text.includes(SECRET), "a chave nunca aparece na resposta");
		const body = JSON.parse(text);
		assert.deepEqual(body.config, { v: 1 });
		assert.deepEqual(body.settings, { sandboxAutoStart: true });
		assert.deepEqual(body.capabilities, { openrouterKey: true, isOwner: true });
		assert.deepEqual(body.effective.models.default, { value: "openai/gpt-4o-mini", source: "default" });
		assert.deepEqual(body.effective.execution.discipline, { value: true, source: "default" });
		assert.equal(body.effective.providers.chatgptEnabled.value, false);
	} finally {
		restore();
	}
});

test("capabilities.openrouterKey é falso sem chave e isOwner falso para outro e-mail", async () => {
	const restore = installFakePrisma(new Map());
	try {
		const res = await appFor(USER_B, "b@example.com", { env: {} as NodeJS.ProcessEnv }).request("/v1/settings");
		assert.deepEqual((await res.json()).capabilities, { openrouterKey: false, isOwner: false });
	} finally {
		restore();
	}
});

test("PATCH grava, devolve efetivo com origem 'user' e persiste; null volta a herdar", async () => {
	const rows = new Map<string, Row>();
	const restore = installFakePrisma(rows);
	try {
		const app = appFor(USER_A, OWNER_EMAIL);
		const res = await patch(app, {
			sandboxAutoStart: false,
			config: {
				models: { default: "anthropic/claude-x", fallbacks: ["a/b", "c/d"] },
				jev: { all: "shadow", features: { intent: "on" } },
				execution: { llmTimeoutPreset: "extended", maxOutputTokens: 8192, discipline: false, contextMemory: "economy" },
			},
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.settings.sandboxAutoStart, false);
		assert.deepEqual(body.effective.models.default, { value: "anthropic/claude-x", source: "user" });
		assert.deepEqual(body.effective.jev.features.intent, { value: "on", source: "user" });
		assert.deepEqual(body.effective.jev.features.tools, { value: "shadow", source: "user" });
		assert.equal(body.effective.execution.llmTimeouts.value.totalMs, 180000);
		assert.deepEqual(body.effective.execution.discipline, { value: false, source: "user" });
		assert.deepEqual(body.effective.execution.contextMemory, { value: "economy", source: "user" });
		assert.deepEqual(rows.get(USER_A)?.configJson, body.config);

		const again = await (await app.request("/v1/settings")).json();
		assert.deepEqual(again.config, body.config);

		const removed = await (await patch(app, { config: { models: { default: null }, jev: null } })).json();
		assert.deepEqual(removed.effective.models.default, { value: "openai/gpt-4o-mini", source: "default" });
		assert.equal(removed.config.jev, undefined);
		assert.deepEqual(removed.config.models, { fallbacks: ["a/b", "c/d"] });
		assert.deepEqual(removed.effective.execution.contextMemory, { value: "economy", source: "user" });
		const back = await (await patch(app, { config: { execution: { contextMemory: null } } })).json();
		assert.deepEqual(back.effective.execution.contextMemory, { value: "standard", source: "default" });
	} finally {
		restore();
	}
});

test("PATCH inválido devolve 400 pt-BR por campo e não grava nada", async () => {
	const rows = new Map<string, Row>();
	const restore = installFakePrisma(rows);
	try {
		const app = appFor(USER_A, OWNER_EMAIL);
		for (const [body, path] of [
			[{ config: { banana: 1 } }, "banana"],
			[{ config: { jev: { mcp: "on" } } }, "jev.mcp"],
			[{ config: { execution: { maxOutputTokens: 1 } } }, "execution.maxOutputTokens"],
			[{ config: { models: { maintenance: "chatgpt/x" } } }, "models.maintenance"],
			[{ config: { models: { default: "id com espaço" } } }, "models.default"],
			[{ config: { execution: { contextMemory: "alto" } } }, "execution.contextMemory"],
			[{ config: { v: 2 } }, "v"],
		] as const) {
			const res = await patch(app, body);
			assert.equal(res.status, 400);
			const json = await res.json();
			assert.equal(json.error, "Configuração inválida");
			assert.ok(json.fields.some((f: { path: string }) => f.path === path), `campo ${path}`);
		}
		assert.equal((await patch(app, { sandboxAutoStart: "sim" })).status, 400);
		assert.equal((await patch(app, [])).status, 400);
		assert.equal(rows.size, 0, "nenhuma linha criada por pedido inválido");
	} finally {
		restore();
	}
});

test("PATCH recusa JSON acima de 4 KB", async () => {
	const restore = installFakePrisma(new Map());
	try {
		const res = await patch(appFor(USER_A, OWNER_EMAIL), { config: { models: { default: "x".repeat(5000) } } });
		assert.equal(res.status, 400);
	} finally {
		restore();
	}
});

test("modelo desconhecido vira 400; catálogo fora do ar aceita", async () => {
	const restore = installFakePrisma(new Map());
	try {
		const unknown = appFor(USER_A, OWNER_EMAIL, { isKnownModel: async () => false });
		const res = await patch(unknown, { config: { models: { vision: "nao/existe" } } });
		assert.equal(res.status, 400);
		assert.equal((await res.json()).fields[0].path, "models.vision");

		const down = appFor(USER_A, OWNER_EMAIL, { isKnownModel: async () => null });
		assert.equal((await patch(down, { config: { models: { vision: "qualquer/coisa" } } })).status, 200);
	} finally {
		restore();
	}
});

test("modelo padrão chatgpt/* passa pela validação do provedor", async () => {
	const restore = installFakePrisma(new Map());
	try {
		const seen: string[] = [];
		const refused = appFor(USER_A, OWNER_EMAIL, {
			validateModel: async (userId, id) => {
				seen.push(`${userId}:${id}`);
				return { status: 400, error: "Conecte o ChatGPT em Configurações → Provedores" };
			},
		});
		const res = await patch(refused, { config: { models: { default: "chatgpt/gpt-5" } } });
		assert.equal(res.status, 400);
		assert.deepEqual(seen, [`${USER_A}:chatgpt/gpt-5`]);
		const accepted = appFor(USER_A, OWNER_EMAIL, { validateModel: async () => ({}) });
		assert.equal((await patch(accepted, { config: { models: { default: "chatgpt/gpt-5" } } })).status, 200);
	} finally {
		restore();
	}
});

test("o dono liga o plano ChatGPT pela configuração; quem não é dono recebe 404 e nada é gravado", async () => {
	const rows = new Map<string, Row>();
	const restore = installFakePrisma(rows);
	try {
		const owner = appFor(USER_A, OWNER_EMAIL, { env: { ...baseEnv, ATLAS_PROVIDER_CHATGPT_ENABLED: "false" } });
		const on = await (await patch(owner, { config: { providers: { chatgptEnabled: true } } })).json();
		assert.deepEqual(on.effective.providers.chatgptEnabled, { value: true, source: "user" });

		const other = appFor(USER_B, "b@example.com");
		const res = await patch(other, { config: { providers: { chatgptEnabled: true } } });
		assert.equal(res.status, 404);
		assert.equal(rows.has(USER_B), false);
	} finally {
		restore();
	}
});

test("IDOR: B não lê, altera nem apaga a config de A; userId no body é ignorado", async () => {
	const rows = new Map<string, Row>();
	const restore = installFakePrisma(rows);
	try {
		const a = appFor(USER_A, OWNER_EMAIL);
		const b = appFor(USER_B, "b@example.com");
		await patch(a, { sandboxAutoStart: false, config: { models: { default: "a/privado" }, jev: { mcp: "gate" } } });

		const seenByB = await (await b.request("/v1/settings?userId=" + USER_A)).json();
		assert.deepEqual(seenByB.config, { v: 1 });
		assert.equal(seenByB.settings.sandboxAutoStart, true);
		assert.equal(seenByB.effective.models.default.source, "default");
		assert.ok(!JSON.stringify(seenByB).includes("a/privado"));

		// B tenta alterar e "apagar" com userId no body e na query: só a própria linha muda.
		await patch(b, { userId: USER_A, sandboxAutoStart: true, config: { models: { default: "b/proprio" } } });
		const del = await b.request("/v1/settings?userId=" + USER_A, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: USER_A, ownerId: USER_A, config: { models: { default: null }, jev: null } }),
		});
		assert.equal(del.status, 200);

		const a2 = await (await a.request("/v1/settings")).json();
		assert.deepEqual(a2.config, { v: 1, models: { default: "a/privado" }, jev: { mcp: "gate" } });
		assert.equal(a2.settings.sandboxAutoStart, false);
		assert.deepEqual(rows.get(USER_B)?.configJson, { v: 1 });
	} finally {
		restore();
	}
});

test("desligar o plano ChatGPT fecha o listener do callback; ligar ou mexer em outra config não", async () => {
	const rows = new Map<string, Row>();
	const restore = installFakePrisma(rows);
	try {
		let stops = 0;
		const owner = appFor(USER_A, OWNER_EMAIL, { stopLoopback: async () => void stops++ });

		await patch(owner, { config: { providers: { chatgptEnabled: true } } });
		assert.equal(stops, 0, "ligar não mexe no listener (ele sobe no Conectar)");

		await patch(owner, { config: { models: { default: "openai/gpt-4o" } } });
		assert.equal(stops, 0);

		const off = await patch(owner, { config: { providers: { chatgptEnabled: false } } });
		assert.equal(off.status, 200);
		assert.equal(stops, 1);
		assert.deepEqual((await off.json()).effective.providers.chatgptEnabled, { value: false, source: "user" });
		// Desligar mantém a config do usuário; os tokens do cofre nem são tocados por esta rota.
		assert.equal((rows.get(USER_A)!.configJson as { providers: { chatgptEnabled: boolean } }).providers.chatgptEnabled, false);
	} finally {
		restore();
	}
});

test("voltar a herdar um env desligado também fecha o listener; env ligado não", async () => {
	const rows = new Map<string, Row>();
	const restore = installFakePrisma(rows);
	try {
		let stops = 0;
		const stopLoopback = async () => void stops++;
		const envOff = appFor(USER_A, OWNER_EMAIL, { stopLoopback });
		await patch(envOff, { config: { providers: { chatgptEnabled: true } } });
		await patch(envOff, { config: { providers: { chatgptEnabled: null } } });
		assert.equal(stops, 1);

		const envOn = appFor(USER_A, OWNER_EMAIL, {
			stopLoopback,
			env: { ...baseEnv, ATLAS_PROVIDER_CHATGPT_ENABLED: "true" } as NodeJS.ProcessEnv,
		});
		await patch(envOn, { config: { providers: { chatgptEnabled: null } } });
		assert.equal(stops, 1, "herdando um env ligado o plano segue ligado");
	} finally {
		restore();
	}
});

test("não-dono nunca fecha nem altera o listener (404 antes de qualquer efeito)", async () => {
	const restore = installFakePrisma(new Map());
	try {
		let stops = 0;
		const other = appFor(USER_B, "b@example.com", { stopLoopback: async () => void stops++ });
		assert.equal((await patch(other, { config: { providers: { chatgptEnabled: false } } })).status, 404);
		assert.equal(stops, 0);
	} finally {
		restore();
	}
});

test("modelo de manutenção aceita Anthropic/OpenCode Go (validados pela chave) e recusa o plano ChatGPT", async () => {
	const restore = installFakePrisma(new Map());
	try {
		const seen: string[] = [];
		const app = appFor(USER_A, OWNER_EMAIL, { validateModel: async (_user, id) => (seen.push(id), {}) });
		const ok = await patch(app, { config: { models: { maintenance: "anthropic-direct/claude-sonnet-5-5" } } });
		assert.equal(ok.status, 200);
		assert.deepEqual(seen, ["anthropic-direct/claude-sonnet-5-5"]);
		assert.equal((await patch(app, { config: { models: { maintenance: "opencode-go/glm-5" } } })).status, 200);
		assert.equal((await patch(app, { config: { models: { maintenance: "chatgpt/gpt-5" } } })).status, 400);
		const refused = appFor(USER_A, OWNER_EMAIL, { validateModel: async () => ({ status: 400, error: "Conecte a Anthropic em Provedores e chaves" }) });
		assert.equal((await patch(refused, { config: { models: { maintenance: "anthropic-direct/x" } } })).status, 400);
	} finally {
		restore();
	}
});
