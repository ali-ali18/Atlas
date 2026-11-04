import { describe, expect, it } from "vitest";
import { PendingBotPatches } from "./home-patches";
import type { HomeBot, HomeSnapshot } from "./home-types";

const bot = (id: string, name: string): HomeBot => ({ id, name, color: "#fff", shape: "blob", pinned: false, pinOrder: null, sectionId: null, memberIds: [], isPrimary: false, conversationId: null, language: "auto", unread: false, lastAt: null, preview: "", previewSent: false });
const snap = (...bots: HomeBot[]): HomeSnapshot => ({ bots, sections: [] });

describe("edições salvas durante uma atualização da home", () => {
	it("o PATCH salvo no meio de uma atualização em voo não é desfeito por ela", () => {
		const patches = new PendingBotPatches();
		const marker = patches.mark(); // a atualização começa
		patches.add("a", { name: "Novo nome" }); // a pessoa salva enquanto ela está em voo
		const stale = snap(bot("a", "Nome velho"), bot("b", "B")); // o servidor respondeu antes do PATCH
		const result = patches.applyOver(stale, marker);
		expect(result.bots.map((item) => item.name)).toEqual(["Novo nome", "B"]);
	});
	it("o que foi salvo antes de a atualização começar já vem do servidor e é descartado", () => {
		const patches = new PendingBotPatches();
		patches.add("a", { name: "Salvo antes" });
		const marker = patches.mark();
		const fresh = snap(bot("a", "Do servidor"));
		expect(patches.applyOver(fresh, marker).bots[0]?.name).toBe("Do servidor");
		// e não volta numa atualização seguinte
		expect(patches.applyOver(fresh, patches.mark()).bots[0]?.name).toBe("Do servidor");
	});
	it("vários patches do mesmo bot valem na ordem; outros bots não mudam", () => {
		const patches = new PendingBotPatches();
		const marker = patches.mark();
		patches.add("a", { name: "1", color: "#000000" });
		patches.add("a", { name: "2" });
		const result = patches.applyOver(snap(bot("a", "x"), bot("b", "b")), marker);
		expect(result.bots[0]).toMatchObject({ name: "2", color: "#000000" });
		expect(result.bots[1]?.name).toBe("b");
	});
	it("duas atualizações em voo: a mais antiga não apaga o patch que a mais nova ainda precisa", () => {
		const patches = new PendingBotPatches();
		const first = patches.mark();
		patches.add("a", { name: "P" });
		const second = patches.mark();
		const fromFirst = patches.applyOver(snap(bot("a", "velho")), first);
		expect(fromFirst.bots[0]?.name).toBe("P");
		// a segunda começou depois do PATCH: o servidor já devolve o nome novo
		expect(patches.applyOver(snap(bot("a", "P")), second).bots[0]?.name).toBe("P");
	});
});

describe("com o controlador de atualização da home", () => {
	it("uma atualização em voo que termina depois do PATCH entrega o nome salvo, e o cache recebe o mesmo", async () => {
		const { HomeSyncController } = await import("./home-sync-controller");
		const patches = new PendingBotPatches();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const delivered: string[] = [];
		const saved: string[] = [];
		const controller = new HomeSyncController(() => ({
			fetch: async () => {
				const marker = patches.mark();
				await gate; // o servidor responde com o nome velho
				return { ok: true as const, snapshot: patches.applyOver(snap(bot("a", "Nome velho")), marker) };
			},
			save: async (_key, snapshot) => void saved.push(snapshot.bots[0]!.name),
			onSnapshot: (snapshot) => void delivered.push(snapshot.bots[0]!.name),
			onError: () => undefined,
			onUnauthorized: async () => undefined,
		}));
		const running = controller.run("conta");
		patches.add("a", { name: "Salvo agora" }); // o PATCH termina enquanto a atualização está em voo
		release();
		expect(await running).toBe("ok");
		expect(delivered).toEqual(["Salvo agora"]);
		expect(saved).toEqual(["Salvo agora"]);
	});
});

describe("bot criado durante uma atualização da home", () => {
	it("a resposta velha (sem o bot novo) não o apaga: ele volta ao topo", () => {
		const patches = new PendingBotPatches();
		const marker = patches.mark(); // a atualização começa
		patches.addBot(bot("novo", "Novo")); // a pessoa cria um bot enquanto ela está em voo
		const stale = snap(bot("a", "A"), bot("b", "B")); // o servidor respondeu antes da criação
		expect(patches.applyOver(stale, marker).bots.map((item) => item.id)).toEqual(["novo", "a", "b"]);
	});
	it("se a resposta já traz o bot, vale a do servidor (sem duplicar)", () => {
		const patches = new PendingBotPatches();
		const marker = patches.mark();
		patches.addBot(bot("novo", "Local"));
		const fresh = snap(bot("novo", "Do servidor"), bot("a", "A"));
		const result = patches.applyOver(fresh, marker);
		expect(result.bots.map((item) => item.name)).toEqual(["Do servidor", "A"]);
	});
	it("criado antes de a atualização começar: o servidor já o devolve, e ele não volta numa atualização seguinte", () => {
		const patches = new PendingBotPatches();
		patches.addBot(bot("novo", "Novo"));
		const marker = patches.mark();
		const fresh = snap(bot("a", "A")); // (por exemplo, o bot foi apagado em outro aparelho)
		expect(patches.applyOver(fresh, marker).bots.map((item) => item.id)).toEqual(["a"]);
		expect(patches.applyOver(fresh, patches.mark()).bots.map((item) => item.id)).toEqual(["a"]);
	});
	it("edição do bot novo feita durante a atualização também vale", () => {
		const patches = new PendingBotPatches();
		const marker = patches.mark();
		patches.addBot(bot("novo", "Novo"));
		patches.add("novo", { name: "Renomeado" });
		expect(patches.applyOver(snap(bot("a", "A")), marker).bots.map((item) => item.name)).toEqual(["Renomeado", "A"]);
	});
	it("trocar de conta (clear) esquece os bots criados", () => {
		const patches = new PendingBotPatches();
		const marker = patches.mark();
		patches.addBot(bot("novo", "Novo"));
		patches.clear();
		expect(patches.applyOver(snap(bot("a", "A")), marker).bots.map((item) => item.id)).toEqual(["a"]);
	});
	it("na atualização do controlador, o bot novo sobrevive ao fetch antigo e vai para o cache", async () => {
		const { HomeSyncController } = await import("./home-sync-controller");
		const patches = new PendingBotPatches();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const delivered: string[][] = [];
		const saved: string[][] = [];
		const controller = new HomeSyncController(() => ({
			fetch: async () => {
				const marker = patches.mark();
				await gate;
				return { ok: true as const, snapshot: patches.applyOver(snap(bot("a", "A")), marker) };
			},
			save: async (_key, value) => void saved.push(value.bots.map((item) => item.id)),
			onSnapshot: (snapshot) => void delivered.push(snapshot.bots.map((item) => item.id)),
			onError: () => undefined,
			onUnauthorized: async () => undefined,
		}));
		const running = controller.run("conta");
		patches.addBot(bot("novo", "Novo"));
		release();
		expect(await running).toBe("ok");
		expect(delivered).toEqual([["novo", "a"]]);
		expect(saved).toEqual([["novo", "a"]]);
	});
});
