import { describe, expect, it } from "vitest";
import { HomeSyncController, type SyncDeps } from "./home-sync-controller";
import type { HomeSnapshot } from "./home-types";

const snap = (name: string): HomeSnapshot => ({ bots: [{ id: name, name, color: "#fff", shape: "blob", pinned: false, pinOrder: null, sectionId: null, memberIds: [], isPrimary: false, conversationId: null, unread: false, lastAt: null, preview: "", previewSent: false }], sections: [] });

function setup() {
	const calls = { saved: [] as string[], shown: [] as string[], errors: [] as string[], unauthorized: 0 };
	const pending: Array<{ resolve: (value: Awaited<ReturnType<SyncDeps["fetch"]>>) => void; signal: AbortSignal }> = [];
	const deps: SyncDeps = {
		fetch: (signal) => new Promise((resolve) => pending.push({ resolve, signal })),
		save: async (key) => void calls.saved.push(key),
		onSnapshot: (value) => void calls.shown.push(value.bots[0]!.name),
		onError: (reason) => void calls.errors.push(reason),
		onUnauthorized: async () => void (calls.unauthorized += 1),
	};
	return { controller: new HomeSyncController(() => deps), calls, pending };
}

describe("HomeSyncController", () => {
	it("grava estado e cache quando nada muda", async () => {
		const { controller, calls, pending } = setup();
		const run = controller.run("a");
		pending[0]!.resolve({ ok: true, snapshot: snap("Alfa") });
		expect(await run).toBe("ok");
		expect(calls).toMatchObject({ saved: ["a"], shown: ["Alfa"] });
	});
	it("sync em voo seguido de logout não grava nada", async () => {
		const { controller, calls, pending } = setup();
		const run = controller.run("a");
		controller.invalidate(); // o usuário saiu
		expect(pending[0]!.signal.aborted).toBe(true);
		pending[0]!.resolve({ ok: true, snapshot: snap("Alfa") }); // a resposta chega tarde
		expect(await run).toBe("cancelled");
		expect(calls).toEqual({ saved: [], shown: [], errors: [], unauthorized: 0 });
	});
	it("logout também cala o 401 e o erro de rede que chegam tarde", async () => {
		const { controller, calls, pending } = setup();
		const first = controller.run("a");
		controller.invalidate();
		pending[0]!.resolve({ ok: false, reason: "unauthorized" });
		expect(await first).toBe("cancelled");
		const second = controller.run("a");
		controller.invalidate();
		pending[1]!.resolve({ ok: false, reason: "network" });
		expect(await second).toBe("cancelled");
		expect(calls.unauthorized).toBe(0);
		expect(calls.errors).toEqual([]);
	});
	it("outra conta aborta a antiga e só a nova grava", async () => {
		const { controller, calls, pending } = setup();
		const a = controller.run("conta-a");
		const b = controller.run("conta-b");
		expect(pending[0]!.signal.aborted).toBe(true);
		pending[0]!.resolve({ ok: true, snapshot: snap("DaA") });
		pending[1]!.resolve({ ok: true, snapshot: snap("DaB") });
		expect(await a).toBe("cancelled");
		expect(await b).toBe("ok");
		expect(calls.saved).toEqual(["conta-b"]);
		expect(calls.shown).toEqual(["DaB"]);
	});
	it("a mesma conta divide o sync em voo", async () => {
		const { controller, pending } = setup();
		const one = controller.run("a");
		const two = controller.run("a");
		expect(pending).toHaveLength(1);
		pending[0]!.resolve({ ok: true, snapshot: snap("Alfa") });
		expect(await Promise.all([one, two])).toEqual(["ok", "ok"]);
	});
	it("401 da conta atual encerra a sessão; falha de rede só avisa", async () => {
		const { controller, calls, pending } = setup();
		const a = controller.run("a");
		pending[0]!.resolve({ ok: false, reason: "unauthorized" });
		expect(await a).toBe("signed-out");
		expect(calls.unauthorized).toBe(1);
		const b = controller.run("a");
		pending[1]!.resolve({ ok: false, reason: "server" });
		expect(await b).toBe("failed");
		expect(calls.errors).toEqual(["server"]);
	});
});
