import { describe, expect, it, vi } from "vitest";
import { ensureHomeBot, type EnsureBotDeps } from "./ensure-bot";
import { fetchHome, fetchHomeBot } from "./home-sync";
import { HomeSyncController } from "./home-sync-controller";
import type { HomeBot, HomeSnapshot } from "./home-types";

const bot = (id: string, conversationId: string | null): HomeBot => ({ id, name: id, color: "#1084FE", shape: "blob", pinned: false, pinOrder: null, sectionId: null, memberIds: [], isPrimary: false, conversationId, language: "auto", unread: false, lastAt: null, preview: "", previewSent: false, previewCard: null });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rawBot = (id: string, conversationId: string | null) => ({ id, name: id, snippet: "", color: "#1084FE", shape: "blob", description: null, openRouterModel: null, language: "auto", pinned: false, pinOrder: null, notify: false, sectionId: null, memberIds: [], conversationId, lastMessage: null });

describe("garantir o bot na home", () => {
	it("entra o bot de verdade (com a conversa), não o provisório, e a atualização é nova", async () => {
		const added: HomeBot[] = [];
		const refresh = vi.fn(async () => undefined);
		const deps: EnsureBotDeps = { fetchBot: async () => bot("b9", "conv-9"), addBot: (item) => void added.push(item), refresh };
		expect(await ensureHomeBot(deps, "b9", bot("b9", null))).toBe(true);
		expect(added).toEqual([bot("b9", "conv-9")]);
		expect(refresh).toHaveBeenCalledWith({ fresh: true });
	});
	it("se a busca falha, entra o provisório (e ainda atualiza); sem provisório, nada entra", async () => {
		const added: HomeBot[] = [];
		const deps: EnsureBotDeps = { fetchBot: async () => Promise.reject(new Error("rede")), addBot: (item) => void added.push(item), refresh: vi.fn(async () => undefined) };
		expect(await ensureHomeBot(deps, "b9", bot("b9", null))).toBe(false);
		expect(added).toEqual([bot("b9", null)]);
		expect(await ensureHomeBot({ ...deps, addBot: (item) => void added.push(item) }, "b9")).toBe(false);
		expect(added).toHaveLength(1);
		expect(deps.refresh).toHaveBeenCalledTimes(2);
	});
	it("fetchHomeBot acha o bot na lista do servidor; ausente ou falha dá null", async () => {
		const ok = vi.fn(async (path: string) => (path === "/v1/bots" ? reply(200, { bots: [rawBot("a", "ca"), rawBot("b9", "conv-9")] }) : reply(200, { sections: [] })));
		expect(await fetchHomeBot(ok, "b9")).toMatchObject({ id: "b9", conversationId: "conv-9" });
		expect(await fetchHomeBot(ok, "zzz")).toBeNull();
		expect(await fetchHomeBot(async () => reply(503, {}), "b9")).toBeNull();
		expect((await fetchHome(ok)).ok).toBe(true);
	});
});

describe("atualização nova (fresh) da home", () => {
	it("sem fresh, divide o voo; com fresh, descarta o voo antigo e busca de novo (o resultado velho não vale)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let calls = 0;
		const delivered: string[][] = [];
		const controller = new HomeSyncController(() => ({
			fetch: async () => {
				const mine = ++calls;
				if (mine === 1) await gate; // a atualização antiga, que começou antes do bot existir
				const snapshot: HomeSnapshot = { bots: mine === 1 ? [bot("a", "ca")] : [bot("a", "ca"), bot("b9", "conv-9")], sections: [] };
				return { ok: true as const, snapshot };
			},
			save: async () => undefined,
			onSnapshot: (snapshot) => void delivered.push(snapshot.bots.map((item) => item.id)),
			onError: () => undefined,
			onUnauthorized: async () => undefined,
		}));
		const old = controller.run("conta");
		expect(controller.run("conta")).toBe(old);
		const fresh = controller.run("conta", true);
		expect(fresh).not.toBe(old);
		release();
		expect(await old).toBe("cancelled");
		expect(await fresh).toBe("ok");
		expect(calls).toBe(2);
		expect(delivered).toEqual([["a", "b9"]]);
	});
});
