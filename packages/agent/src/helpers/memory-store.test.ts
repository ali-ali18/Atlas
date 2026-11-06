import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.js";

const entry = (overrides: Partial<Parameters<ReturnType<typeof createMemoryStore>["journal"]["append"]>[0]> = {}) => ({
	runId: "r1",
	userId: "u1",
	step: 1,
	idempotencyKey: "k1",
	toolName: "create_file",
	argsHash: "h",
	outcome: "started" as const,
	...overrides,
});

describe("createMemoryStore (store em memória compartilhado por ajudantes e eval)", () => {
	it("checkpoint e nota são copiados: mudar o objeto vivo depois não altera o que foi salvo", async () => {
		const store = createMemoryStore();
		const payload = { items: ["a"] };
		await store.runs.saveCheckpoint({ runId: "r1", userId: "u1", step: 1, state: "MODEL", payload } as never);
		payload.items.push("b");
		const loaded = await store.runs.loadCheckpoint("u1", "r1");
		expect((loaded?.payload as typeof payload).items).toEqual(["a"]);
		const note = { id: "n1", userId: "u1", title: "t", body: "corpo", pinned: false };
		await store.notes.save(note);
		note.body = "mudou";
		expect((await store.notes.get("u1", "n1"))?.body).toBe("corpo");
	});

	it("journal: `started` repetido não é reassumido (claim), `failed` pode ser reassumido", async () => {
		const store = createMemoryStore();
		expect(await store.journal.append(entry())).toEqual({ claimed: true });
		expect(await store.journal.append(entry())).toEqual({ claimed: false });
		await store.journal.append(entry({ outcome: "failed" }));
		expect(await store.journal.append(entry())).toEqual({ claimed: true });
	});

	it("tudo é escopado pelo dono: o usuário B não lê a nota nem o journal do A", async () => {
		const store = createMemoryStore();
		await store.notes.save({ id: "n1", userId: "u1", title: "t", body: "b", pinned: false });
		await store.journal.append(entry());
		expect(await store.notes.get("u2", "n1")).toBeNull();
		expect(await store.notes.list("u2")).toEqual([]);
		expect(await store.journal.list("u2", "r1")).toEqual([]);
		expect(await store.journal.find("u2", "r1", "k1")).toBeNull();
	});
});
