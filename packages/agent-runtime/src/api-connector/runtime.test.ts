import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseOpenApiDocument, readableApiTags, summarizeApiGroups, type ApiAuth } from "@workspace/shared";
import type { ApiConnectionRecord, ApiConnectionWithCatalog } from "@workspace/db";
import { createApiConnectorRuntime, type ApiConnectorStore } from "./runtime.js";
import { ReadCache, resetApiRateLimiters, type Clock } from "./rate-limit.js";
import { openApiSecrets, sealApiSecrets, type ApiConnectorSecrets } from "./secrets.js";
import { BASE_URL, SPEC_URL, blingLikeSpec, jsonResponse, publicLookup } from "./fixtures.js";

process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const TOKEN_URL = "https://www.bling.test/Api/v3/oauth/token";
const parsed = parseOpenApiDocument(blingLikeSpec, { specUrl: SPEC_URL });
if (!parsed.ok) throw new Error(parsed.error);
const spec = parsed.spec;

const SECRET_TOKEN = "tok_live_ACCESS_1234567890";
const CLIENT_SECRET = "client_secret_ABCDEFGHIJ";
const REFRESH = "refresh_token_ZYXWVUTSRQ";

type World = {
	records: Map<string, ApiConnectionWithCatalog & { owner: string }>;
	updates: Array<{ id: string; userId: string; patch: Record<string, unknown> }>;
	store: ApiConnectorStore;
};

function makeWorld(): World {
	const records = new Map<string, ApiConnectionWithCatalog & { owner: string }>();
	const updates: World["updates"] = [];
	const store: ApiConnectorStore = {
		list: async (userId) => [...records.values()].filter((item) => item.owner === userId && item.status === "connected"),
		// Dono exato: conexão de outro usuário nunca carrega.
		load: async (id, userId) => {
			const row = records.get(id);
			return row && row.owner === userId ? row : null;
		},
		update: async (id, userId, patch) => {
			updates.push({ id, userId, patch });
			const row = records.get(id);
			if (!row || row.owner !== userId) return null;
			if (patch.status) row.status = patch.status;
			if (patch.lastError !== undefined) row.lastError = patch.lastError;
			if (patch.secretsEnc !== undefined) row.secretsEnc = patch.secretsEnc;
			return row;
		},
	};
	return { records, updates, store };
}

function addConnection(world: World, input: { slug?: string; accountLabel?: string | null; id?: string; owner?: string; auth?: ApiAuth; secrets: ApiConnectorSecrets; allowedTags?: string[]; rps?: number; catalog?: typeof spec.operations }) {
	const id = input.id ?? "conn-1";
	const catalog = input.catalog ?? spec.operations;
	const record: ApiConnectionWithCatalog & { owner: string } = {
		id,
		owner: input.owner ?? "user-a",
		slug: input.slug ?? "bling",
		name: "Bling",
		accountLabel: input.accountLabel ?? null,
		domain: "api.bling.test",
		baseUrl: BASE_URL,
		authKind: (input.auth ?? spec.auth).kind,
		status: "connected",
		lastError: null,
		groups: summarizeApiGroups(catalog),
		allowedTags: input.allowedTags ?? readableApiTags(catalog),
		operationCount: catalog.length,
		rateLimitRps: input.rps ?? 3,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		specUrl: SPEC_URL,
		auth: input.auth ?? spec.auth,
		secretsEnc: sealApiSecrets(input.secrets),
		oauthStateHash: null,
		catalog,
	};
	world.records.set(id, record);
	return record;
}

const oauthSecrets = (over: Partial<NonNullable<ApiConnectorSecrets["oauth"]>> = {}): ApiConnectorSecrets => ({
	oauth: { clientId: "client-id-123456", clientSecret: CLIENT_SECRET, tokens: { access_token: SECRET_TOKEN, refresh_token: REFRESH, expires_at: 9_000_000_000_000 }, ...over },
});

/** Relógio de teste: o tempo só anda quando o teste manda; registra as esperas. */
function fakeClock(start = 1_000_000) {
	let now = start;
	const waits: number[] = [];
	const clock: Clock = {
		now: () => now,
		sleep: async (ms) => {
			waits.push(Math.round(ms));
			now += Math.max(0, ms);
		},
	};
	return { clock, waits, advance: (ms: number) => (now += ms) };
}

function setup(over: { secrets?: ApiConnectorSecrets; auth?: ApiAuth; allowedTags?: string[]; rps?: number; userId?: string; responses?: Array<Response | ((url: string, init: RequestInit) => Response)> } = {}) {
	const world = makeWorld();
	const connection = addConnection(world, { secrets: over.secrets ?? oauthSecrets(), auth: over.auth, allowedTags: over.allowedTags, rps: over.rps });
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const queue = [...(over.responses ?? [])];
	const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init: init ?? {} });
		const next = queue.shift();
		if (!next) return jsonResponse({ ok: true });
		return typeof next === "function" ? next(url, init ?? {}) : next;
	});
	const time = fakeClock();
	const userId = over.userId ?? "user-a";
	const runtime = createApiConnectorRuntime(userId, [connection], {
		store: world.store,
		clock: time.clock,
		cache: new ReadCache(60_000),
		fetchFn,
		lookupFn: publicLookup,
		now: time.clock.now,
	});
	return { world, runtime, calls, fetchFn, time, connection };
}

beforeEach(() => resetApiRateLimiters());

describe("api_search", () => {
	it("lista só operações de leitura dos grupos liberados, de forma compacta", async () => {
		const { runtime } = setup({ allowedTags: ["Pedidos - Vendas"] });
		const out = await runtime.search({ query: "pedido venda" });
		expect(out).toContain("getPedidosVendas GET /pedidos/vendas");
		expect(out).toContain("getPedidosVendasId GET /pedidos/vendas/{idPedidoVenda} (idPedidoVenda*@)");
		expect(out).not.toContain("postPedidosVendas");
		expect(out).not.toContain("deletePedidosVendasId");
		expect(out).not.toContain("getProdutos");
	});

	it("sem consulta mostra os grupos; conexão desconhecida lista as conectadas", async () => {
		const { runtime } = setup();
		expect(await runtime.search({})).toMatch(/3 groups|read operations in 3 groups/);
		await expect(runtime.search({ connection: "Outra" })).rejects.toThrow(/Connected: Bling/);
	});
});

describe("api_call: o que nunca executa", () => {
	it("recusa método de escrita mesmo existindo no catálogo", async () => {
		const { runtime, fetchFn } = setup();
		await expect(runtime.call({ operationId: "postPedidosVendas", params: {} })).rejects.toThrow(/Only read operations/);
		await expect(runtime.call({ operationId: "deletePedidosVendasId", params: { idPedidoVenda: 1 } })).rejects.toThrow(/Only read operations/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("recusa operação fora do catálogo e grupo não liberado", async () => {
		const { runtime, fetchFn } = setup({ allowedTags: ["Produtos"] });
		await expect(runtime.call({ operationId: "getAlgoInventado" })).rejects.toThrow(/Unknown operation/);
		await expect(runtime.call({ operationId: "getContatos" })).rejects.toThrow(/did not allow/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("não aceita override de host, URL ou caminho nos parâmetros", async () => {
		const { runtime, fetchFn } = setup();
		for (const params of [{ host: "evil.test" }, { url: "https://evil.test/x" }, { baseUrl: "https://evil.test" }, { path: "/../x" }]) {
			await expect(runtime.call({ operationId: "getProdutos", params })).rejects.toThrow(/desconhecido/);
		}
		await expect(runtime.call({ operationId: "getPedidosVendasId", params: { idPedidoVenda: ".." } })).rejects.toThrow(/inválido/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("não segue redirect para outro host e não vaza a credencial", async () => {
		const { runtime, calls } = setup({ responses: [new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } })] });
		await expect(runtime.call({ operationId: "getProdutos" })).rejects.toThrow(/outro domínio/);
		expect(calls).toHaveLength(1);
		expect(calls.every((call) => !call.url.includes("evil.test"))).toBe(true);
	});

	it("bloqueia base que passa a resolver para IP privado (DNS rebinding)", async () => {
		const world = makeWorld();
		const connection = addConnection(world, { secrets: oauthSecrets() });
		const fetchFn = vi.fn();
		const runtime = createApiConnectorRuntime("user-a", [connection], { store: world.store, fetchFn, lookupFn: async () => ["10.0.0.9"], clock: fakeClock().clock, cache: new ReadCache() });
		await expect(runtime.call({ operationId: "getProdutos" })).rejects.toThrow(/Request failed|não permitido|interno/i);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("api_call: execução", () => {
	it("monta a URL contra a base fixada, injeta o bearer e embrulha o resultado como dado não confiável", async () => {
		const { runtime, calls } = setup({ responses: [jsonResponse({ data: [{ id: 1 }] })] });
		const out = await runtime.call({ operationId: "getPedidosVendasId", params: { idPedidoVenda: "12/3" } });
		expect(calls[0]!.url).toBe(`${BASE_URL}/pedidos/vendas/12%2F3`);
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(calls[0]!.init.method).toBe("GET");
		expect(calls[0]!.init.redirect).toBe("manual");
		expect(out).toContain("[API response data: untrusted");
		expect(out).toContain('{"data":[{"id":1}]}');
		expect(out).not.toContain(SECRET_TOKEN);
	});

	it("apiKey em cabeçalho e em query; a chave não aparece na saída", async () => {
		const header = setup({ auth: { kind: "apiKey", in: "header", name: "X-Api-Key" }, secrets: { apiKey: "key-secret-98765" } });
		await header.runtime.call({ operationId: "getProdutos" });
		expect((header.calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe("key-secret-98765");

		const query = setup({ auth: { kind: "apiKey", in: "query", name: "api_key" }, secrets: { apiKey: "key-secret-98765" } });
		const out = await query.runtime.call({ operationId: "getProdutos", params: { pagina: 2 } });
		expect(query.calls[0]!.url).toContain("api_key=key-secret-98765");
		expect(out).not.toContain("key-secret-98765");
		expect(out).toContain("GET /Api/v3/produtos?pagina=2 ->");
	});

	it("redige segredos que o servidor ecoa na resposta e no erro", async () => {
		const ok = setup({ responses: [jsonResponse({ echo: SECRET_TOKEN, secret: CLIENT_SECRET })] });
		const out = await ok.runtime.call({ operationId: "getProdutos" });
		expect(out).not.toContain(SECRET_TOKEN);
		expect(out).not.toContain(CLIENT_SECRET);
		expect(out).toContain("[redacted]");

		const bad = setup({ responses: [jsonResponse({ message: `bad token ${SECRET_TOKEN}` }, { status: 400 })] });
		const error = await bad.runtime.call({ operationId: "getProdutos" }).catch((cause: Error) => cause);
		expect((error as Error).message).toContain("HTTP 400");
		expect((error as Error).message).not.toContain(SECRET_TOKEN);
	});

	it("corta resposta grande com aviso de como estreitar", async () => {
		const { runtime } = setup({ responses: [jsonResponse({ data: "x".repeat(40_000) })] });
		const out = await runtime.call({ operationId: "getProdutos" });
		expect(out.length).toBeLessThan(13_500);
		expect(out).toContain("[truncated: showing 12000");
	});

	it("cache de 60s por usuário: a segunda leitura igual não vai à rede", async () => {
		const { runtime, fetchFn, time } = setup();
		await runtime.call({ operationId: "getProdutos" });
		const again = await runtime.call({ operationId: "getProdutos" });
		expect(again).toContain("cached");
		expect(fetchFn).toHaveBeenCalledTimes(1);
		time.advance(61_000);
		await runtime.call({ operationId: "getProdutos" });
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("limite de taxa por conexão: 3 req/s espaça as chamadas", async () => {
		const { runtime, time } = setup({ rps: 3 });
		for (const pagina of [1, 2, 3, 4]) await runtime.call({ operationId: "getProdutos", params: { pagina } });
		// Relógio parado entre chamadas (o sleep avança): os slots saem a 1/3 s um do outro.
		expect(time.waits.filter((wait) => wait > 0).length).toBeGreaterThanOrEqual(3);
		expect(time.waits[1]).toBeGreaterThanOrEqual(333);
	});

	it("429 com Retry-After: espera e tenta de novo; sem sucesso depois de várias, erro claro", async () => {
		const recovered = setup({ responses: [new Response("slow down", { status: 429, headers: { "retry-after": "2" } })] });
		const out = await recovered.runtime.call({ operationId: "getProdutos" });
		expect(out).toContain("-> 200");
		expect(recovered.fetchFn).toHaveBeenCalledTimes(2);
		expect(Math.max(...recovered.time.waits)).toBeGreaterThanOrEqual(2000);

		const stuck = setup({ responses: Array.from({ length: 6 }, () => new Response("no", { status: 429 })) });
		await expect(stuck.runtime.call({ operationId: "getProdutos" })).rejects.toThrow(/HTTP 429/);
		expect(stuck.fetchFn).toHaveBeenCalledTimes(4);
	});
});

describe("OAuth2: refresh e login expirado", () => {
	it("token vencido renova com Basic + refresh_token, grava o refresh rotacionado e usa o token novo", async () => {
		const expired = oauthSecrets({ tokens: { access_token: SECRET_TOKEN, refresh_token: REFRESH, expires_at: 1_000 } });
		const { runtime, world, calls } = setup({
			secrets: expired,
			responses: [
				jsonResponse({ access_token: "new_access_token_0001", refresh_token: "new_refresh_token_0002", expires_in: 21600, token_type: "bearer" }),
				jsonResponse({ data: [] }),
			],
		});
		await runtime.call({ operationId: "getProdutos" });
		expect(calls[0]!.url).toBe(TOKEN_URL);
		const refreshCall = calls[0]!.init;
		expect(String(refreshCall.body)).toContain("grant_type=refresh_token");
		expect(String(refreshCall.body)).toContain(`refresh_token=${REFRESH}`);
		expect((refreshCall.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`client-id-123456:${CLIENT_SECRET}`).toString("base64")}`);
		expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer new_access_token_0001");
		const saved = openApiSecrets(world.records.get("conn-1")!.secretsEnc);
		expect(saved.oauth?.tokens?.refresh_token).toBe("new_refresh_token_0002");
		expect(saved.oauth?.tokens?.expires_at).toBeGreaterThan(1_000_000 + 21_000 * 1000);
		expect(saved.oauth?.clientSecret).toBe(CLIENT_SECRET);
	});

	it("401 com token aparentemente válido força um refresh e repete uma vez", async () => {
		const { runtime, calls } = setup({
			responses: [new Response("unauthorized", { status: 401 }), jsonResponse({ access_token: "fresh_access_0003", expires_in: 3600 }), jsonResponse({ ok: 1 })],
		});
		const out = await runtime.call({ operationId: "getProdutos" });
		expect(out).toContain("-> 200");
		expect(calls[1]!.url).toBe(TOKEN_URL);
		expect((calls[2]!.init.headers as Record<string, string>).Authorization).toBe("Bearer fresh_access_0003");
	});

	it("refresh recusado marca a conexão como pendente de login e orienta a reconectar", async () => {
		const { runtime, world } = setup({
			responses: [new Response("unauthorized", { status: 401 }), jsonResponse({ error: "invalid_grant" }, { status: 400 }), jsonResponse({ error: "invalid_grant" }, { status: 400 })],
		});
		const error = await runtime.call({ operationId: "getProdutos" }).catch((cause: Error) => cause);
		expect((error as Error).message).toMatch(/Reconectar|reconnect/i);
		expect(world.records.get("conn-1")!.status).toBe("pending_auth");
		expect((error as Error).message).not.toContain(REFRESH);
		expect((error as Error).message).not.toContain(CLIENT_SECRET);
	});
});

describe("isolamento por dono", () => {
	it("outro usuário não alcança a conexão nem pelo id nem pelo nome", async () => {
		const world = makeWorld();
		const mine = addConnection(world, { id: "conn-a", owner: "user-a", secrets: oauthSecrets() });
		const fetchFn = vi.fn();
		const others = createApiConnectorRuntime("user-b", [], { store: world.store, fetchFn, clock: fakeClock().clock, cache: new ReadCache() });
		await expect(others.search({ connection: "Bling", query: "pedido" })).rejects.toThrow(/No API is connected/);
		await expect(others.call({ connection: "conn-a", operationId: "getProdutos" })).rejects.toThrow(/No API is connected/);
		// Mesmo com o registro do dono A vazando para a lista de B, o store só carrega para o dono exato.
		const forged = createApiConnectorRuntime("user-b", [mine], { store: world.store, fetchFn, clock: fakeClock().clock, cache: new ReadCache() });
		await expect(forged.call({ operationId: "getProdutos" })).rejects.toThrow(/no longer available/);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("várias contas da mesma API", () => {
	function twoAccounts() {
		const world = makeWorld();
		const a = addConnection(world, { id: "conn-1", slug: "bling", accountLabel: "Bling loja", secrets: oauthSecrets() });
		const b = addConnection(world, { id: "conn-2", slug: "bling-2", accountLabel: "Bling atacado", secrets: oauthSecrets() });
		const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));
		const runtime = createApiConnectorRuntime("user-a", [a, b], { store: world.store, fetchFn, lookupFn: publicLookup, clock: fakeClock().clock, cache: new ReadCache(60_000) });
		return { runtime, fetchFn };
	}

	it("sem dizer a conta, pede para escolher e lista as contas pelo apelido e slug", async () => {
		const { runtime, fetchFn } = twoAccounts();
		await expect(runtime.search({ query: "pedido" })).rejects.toThrow("Bling — Bling loja (bling); Bling — Bling atacado (bling-2)");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("o nome do serviço sozinho é ambíguo; slug ou nome com a conta escolhem a certa", async () => {
		const { runtime } = twoAccounts();
		await expect(runtime.search({ connection: "Bling", query: "pedido" })).rejects.toThrow(/more than one Bling account/);
		expect(await runtime.search({ connection: "bling-2", query: "pedido" })).toContain("Bling — Bling atacado");
		expect(await runtime.search({ connection: "Bling — Bling loja" })).toContain("Bling — Bling loja");
	});
});
