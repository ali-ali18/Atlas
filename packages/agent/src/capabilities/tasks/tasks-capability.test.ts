import { describe, expect, it } from "vitest";
import { createNoteTaskListStore, taskListNoteId } from "../../adapters/task-list.js";
import { FakeTaskListStore } from "../../presets/fakes.js";
import { call, kernelHarness, MemoryNotes, reply } from "../../testing/kernel-fakes.js";
import type { ToolContext } from "../../tools/types.js";
import { createTasksCapability } from "./tasks-capability.js";

const ctx = (ownerId = "o1", runId = "run-1"): ToolContext => ({ runId, ownerId, ports: {} as ToolContext["ports"] });
const items = (...statuses: Array<"pending" | "in_progress" | "completed">) => statuses.map((status, i) => ({ content: `Passo ${i + 1}`, status }));

describe("capacidade tasks", () => {
	it("update_task_list é draft (rascunho do bot, sem aprovação) e lazy", () => {
		const cap = createTasksCapability(new FakeTaskListStore());
		expect(cap.core).toBe(false);
		expect(cap.tools[0]).toMatchObject({ name: "update_task_list", effect: "draft", privateData: false, egress: false, trust: "trusted" });
	});

	it("salva a lista inteira, devolve o placar e o recibo", async () => {
		const store = new FakeTaskListStore();
		const tool = createTasksCapability(store).tools[0]!;
		const out = await tool.run({ items: items("completed", "in_progress", "pending"), deliverable: "document" }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { what: "Task list: 1 of 3 done", where: "This run" } });
		expect(out.ok && out.summary).toContain("Task list saved (1/3 done).");
		expect(out.ok && out.summary).toContain("2. [>] Passo 2");
		expect(out.ok && out.summary).toContain("Deliverable: document.");
		expect(await store.get("o1", "run-1")).toEqual({ items: items("completed", "in_progress", "pending"), deliverable: "document" });
	});

	it("o deliverable declarado se mantém quando a lista é reenviada sem ele", async () => {
		const store = new FakeTaskListStore();
		const tool = createTasksCapability(store).tools[0]!;
		await tool.run({ items: items("in_progress"), deliverable: "answer" }, ctx());
		await tool.run({ items: items("completed") }, ctx());
		expect((await store.get("o1", "run-1"))?.deliverable).toBe("answer");
	});

	it("tudo concluído manda entregar; lista vazia limpa", async () => {
		const tool = createTasksCapability(new FakeTaskListStore()).tools[0]!;
		const done = await tool.run({ items: items("completed", "completed") }, ctx());
		expect(done.ok && done.summary).toContain("give the owner the result");
		const cleared = await tool.run({ items: [] }, ctx());
		expect(cleared).toMatchObject({ ok: true, receipt: { what: "Cleared the task list" } });
	});

	it("valida com a lista do que é aceito: status, dois em andamento, campo desconhecido, limite", async () => {
		const tool = createTasksCapability(new FakeTaskListStore()).tools[0]!;
		const badStatus = await tool.run({ items: [{ content: "a", status: "doing" }] }, ctx());
		expect(!badStatus.ok && badStatus.error).toContain("pending");
		const two = await tool.run({ items: items("in_progress", "in_progress") }, ctx());
		expect(two).toMatchObject({ ok: false, error: expect.stringContaining("At most one"), hint: expect.stringContaining("pending, in_progress or completed") });
		expect((await tool.run({ items: [{ content: "a", status: "pending", owner: "x" }] }, ctx())).ok).toBe(false);
		expect((await tool.run({ items: Array.from({ length: 21 }, () => ({ content: "a", status: "pending" })) }, ctx())).ok).toBe(false);
		expect((await tool.run({ items: [{ content: "a".repeat(161), status: "pending" }] }, ctx())).ok).toBe(false);
		const badDeliverable = await tool.run({ items: [], deliverable: "pdf" }, ctx());
		expect(!badDeliverable.ok && badDeliverable.error).toContain("document");
	});

	it("a lista é do run e do dono: outro run e outro dono não a veem", async () => {
		const store = new FakeTaskListStore();
		const tool = createTasksCapability(store).tools[0]!;
		await tool.run({ items: items("pending") }, ctx("o1", "run-1"));
		expect(await store.get("o1", "run-2")).toBeNull();
		expect(await store.get("o2", "run-1")).toBeNull();
	});
});

describe("adaptador de lista de tarefas sobre o caderno", () => {
	it("guarda em nota work:<run>:tasks escopada pelo dono e relê", async () => {
		const notes = new MemoryNotes();
		const store = createNoteTaskListStore(notes);
		await store.set("o1", "run-1", { items: items("pending"), deliverable: "answer" });
		expect(notes.items.get(`o1:${taskListNoteId("run-1")}`)?.id).toBe("work:run-1:tasks");
		expect(await store.get("o1", "run-1")).toEqual({ items: items("pending"), deliverable: "answer" });
		expect(await store.get("o2", "run-1")).toBeNull();
	});
	it("nota corrompida vira 'sem lista', nunca quebra o run", async () => {
		const notes = new MemoryNotes();
		await notes.save({ id: taskListNoteId("run-1"), userId: "o1", title: "x", body: "{não é json", pinned: false });
		expect(await createNoteTaskListStore(notes).get("o1", "run-1")).toBeNull();
	});
});

describe("tasks no kernel", () => {
	it("o modelo carrega a capacidade, grava a lista e o recibo vira registro do run", async () => {
		const store = new FakeTaskListStore();
		const h = kernelHarness(
			[
				reply({ calls: [call("a", "use_capability", { id: "tasks" })] }),
				reply({ calls: [call("b", "update_task_list", { items: items("in_progress", "pending"), deliverable: "document" })] }),
				reply({ text: "Feito." }),
			],
			{ capabilities: [createTasksCapability(store)] },
		);
		const result = await h.run();
		expect(result.status).toBe("done");
		expect(h.llm.requests[0]?.tools?.map((t) => t.name)).not.toContain("update_task_list");
		expect(h.llm.requests[1]?.tools?.map((t) => t.name)).toContain("update_task_list");
		expect((await store.get("owner-1", "run-1"))?.items).toHaveLength(2);
	});
});
