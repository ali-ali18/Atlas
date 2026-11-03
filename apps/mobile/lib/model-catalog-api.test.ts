import { describe, expect, it } from "vitest";
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";
import { fetchModelCatalog } from "./model-catalog-api";

const models = { models: [{ id: "a/one", name: "A: One", provider: "a", contextLength: 8000 }, { id: "b/two", name: "B: Two", provider: "b", contextLength: 8000 }] };

function server(routes: Record<string, { status?: number; body?: unknown }>) {
	const paths: string[] = [];
	const apiFetch: ApiFetch = async (path) => {
		paths.push(path);
		const route = routes[path];
		return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? (route ? 200 : 404) });
	};
	return { apiFetch, paths };
}

describe("fetchModelCatalog", () => {
	it("lê os mesmos endpoints do web e monta principais (níveis + modelo do bot) e outros", async () => {
		const { apiFetch, paths } = server({
			"/v1/models": { body: models },
			"/v1/settings": { body: { effective: { models: { tiers: { value: { easy: ["b/two"] } } } } } },
			"/v1/bots": { body: { bots: [{ id: "bot1", openRouterModel: "a/one" }] } },
		});
		const catalog = await fetchModelCatalog(apiFetch, "bot1");
		expect([...paths].sort()).toEqual(["/v1/bots", "/v1/models", "/v1/provider-keys", "/v1/providers", "/v1/settings"]);
		expect(catalog.bot).toEqual({ known: true, model: "a/one", tiers: false });
		expect(catalog.featured.map((option) => option.id)).toEqual(["a/one", "b/two"]);
		expect(catalog.others).toEqual([]);
	});
	it("níveis ou bots indisponíveis não derrubam o seletor", async () => {
		const { apiFetch } = server({ "/v1/models": { body: models }, "/v1/settings": { status: 503 } });
		const catalog = await fetchModelCatalog(apiFetch, "bot1");
		expect(catalog.bot.known).toBe(false);
		expect(catalog.featured.length + catalog.others.length).toBe(2);
	});
	it("soma o plano ChatGPT e as chaves próprias conectadas, como o web", async () => {
		const { apiFetch, paths } = server({
			"/v1/models": { body: models },
			"/v1/providers": { body: { providers: [{ provider: "chatgpt", status: "connected" }] } },
			"/v1/providers/chatgpt/models": { body: { models: [{ id: "chatgpt/luna", name: "GPT-5 Luna", provider: "chatgpt" }] } },
			"/v1/provider-keys": { body: { providers: [{ provider: "anthropic", status: "connected" }, { provider: "opencode-go", status: "disconnected" }] } },
			"/v1/provider-keys/anthropic/models": { body: { models: [{ id: "anthropic-direct/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic" }] } },
		});
		const catalog = await fetchModelCatalog(apiFetch, "bot1");
		expect(paths).toContain("/v1/providers/chatgpt/models");
		expect(paths).toContain("/v1/provider-keys/anthropic/models");
		expect(paths).not.toContain("/v1/provider-keys/opencode-go/models");
		expect([...catalog.featured, ...catalog.others].map((option) => option.id).sort()).toEqual(["a/one", "anthropic-direct/claude-sonnet-5.5", "b/two", "chatgpt/luna"]);
		expect(catalog.complete).toBe(true);
	});
	it("plano ChatGPT desligado (404) não é falha; provedor que falhou deixa o catálogo incompleto", async () => {
		const off = server({ "/v1/models": { body: models }, "/v1/providers": { status: 404 }, "/v1/provider-keys": { status: 404 } });
		expect((await fetchModelCatalog(off.apiFetch, "bot1")).complete).toBe(true);
		const broken = server({ "/v1/models": { body: models }, "/v1/providers": { body: { providers: [{ provider: "chatgpt", status: "connected" }] } }, "/v1/providers/chatgpt/models": { status: 503 }, "/v1/provider-keys": { status: 404 } });
		expect((await fetchModelCatalog(broken.apiFetch, "bot1")).complete).toBe(false);
	});
	it("catálogo indisponível ou torto é erro (a folha oferece tentar de novo)", async () => {
		await expect(fetchModelCatalog(server({ "/v1/models": { status: 502 } }).apiFetch, "bot1")).rejects.toBeInstanceOf(ChatApiError);
		await expect(fetchModelCatalog(server({ "/v1/models": { body: { models: "x" } } }).apiFetch, "bot1")).rejects.toMatchObject({ status: 502 });
	});
	it("401 em qualquer endpoint sobe (o app encerra a sessão)", async () => {
		const { apiFetch } = server({ "/v1/models": { body: models }, "/v1/bots": { status: 401 } });
		await expect(fetchModelCatalog(apiFetch, "bot1")).rejects.toMatchObject({ status: 401 });
	});
});
