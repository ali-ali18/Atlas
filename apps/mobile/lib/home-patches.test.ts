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
