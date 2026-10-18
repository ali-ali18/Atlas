import { expect, it, vi } from "vitest";
import { createChatgptModelCatalog } from "./provider-model-catalog.js";
import type { ProviderStatus } from "@workspace/shared";

const state = (userId: string): ProviderStatus => ({ provider: "chatgpt", status: "connected", accountEmail: `${userId}@example.com`, updatedAt: "revision-1", lastLimitAt: null });
it("cache e single-flight são isolados pelo dono, com modelos ocultos apenas se selecionados", async () => {
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		expect(init?.redirect).toBe("error");
		const auth = new Headers(init?.headers).get("Authorization");
		const slug = auth?.endsWith("a") ? "a" : "b";
		return Response.json({ models: [{ slug, visibility: "list" }, { slug: `${slug}-hidden`, visibility: "hidden" }] });
	});
	const catalog = createChatgptModelCatalog({ status: async userId => state(userId), getAccessToken: async userId => userId, fetch: fetcher });
	const [a1, a2, b] = await Promise.all([catalog.list("a"), catalog.list("a"), catalog.list("b")]);
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(a1.models.map(model => model.id)).toEqual(["chatgpt/a"]);
	expect(a2).toEqual(a1); expect(b.models[0]?.id).toBe("chatgpt/b");
	expect((await catalog.list("a", "chatgpt/a-hidden")).models).toHaveLength(2);
});

it("stale e cooldown evitam martelar o provedor, e desconexão limpa o cache", async () => {
	let now = 0; let status = state("a"); let fail = false;
	const fetcher = vi.fn(async () => { if (fail) throw new Error("synthetic network error"); return Response.json({ models: [{ slug: "a", visibility: "list" }] }); });
	const catalog = createChatgptModelCatalog({ status: async () => status, getAccessToken: async () => "synthetic", fetch: fetcher, now: () => now });
	expect((await catalog.list("a")).models).toHaveLength(1);
	now = 3_600_001; fail = true;
	expect((await catalog.list("a")).models).toHaveLength(1);
	await catalog.list("a"); expect(fetcher).toHaveBeenCalledTimes(2);
	status = { ...status, status: "disconnected" }; expect((await catalog.list("a")).models).toEqual([]);
	status = { ...state("a"), updatedAt: "revision-2" }; fail = false;
	expect((await catalog.list("a")).models).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(3);
});

it("nega credenciais de outro dono antes do fetch e tolera catálogo indisponível", async () => {
	const fetcher = vi.fn(async () => { throw new Error("unavailable"); });
	const catalog = createChatgptModelCatalog({ status: async userId => { if (userId === "b") throw Object.assign(new Error("not_found"), { status: 404 }); return state(userId); }, getAccessToken: async () => "synthetic", fetch: fetcher });
	await expect(catalog.list("b")).rejects.toHaveProperty("status", 404); expect(fetcher).not.toHaveBeenCalled();
	expect(await catalog.isKnown("a", "chatgpt/a")).toBe(null);
	expect(await catalog.list("a")).toMatchObject({ models: [], status: "connected", catalogAvailable: false });
});

it("não entrega catálogo de conta alterada durante a consulta", async () => {
	let status = state("a");
	const catalog = createChatgptModelCatalog({ status: async () => status, getAccessToken: async () => "synthetic", fetch: async () => { status = { ...status, updatedAt: "new-registration" }; return Response.json({ models: [{ slug: "old", visibility: "list" }] }); } });
	expect((await catalog.list("a")).models).toEqual([]);
});

it("login por código: catálogo vem do backend do plano com a conta do usuário", async () => {
	const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ models: [{ slug: "gpt-5", visibility: "list" }] }));
	const catalog = createChatgptModelCatalog({ status: async userId => state(userId), getAccessToken: async () => "codex-access", getAccountId: async () => "acct-123", fetch: fetcher });
	expect((await catalog.list("a")).models.map(model => model.id)).toEqual(["chatgpt/gpt-5"]);
	const [url, init] = fetcher.mock.calls[0]!;
	expect(String(url)).toMatch(/^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/);
	expect(new Headers(init?.headers).get("ChatGPT-Account-ID")).toBe("acct-123");
});
