import { describe, expect, it } from "vitest";
import { FakeAgenda } from "../../presets/fakes.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { Ports } from "../../ports/index.js";
import type { ToolContext } from "../../tools/types.js";
import { createAgendaCapability } from "./agenda-capability.js";
import { BRIEF_DEFAULT_NOTE } from "./brief-set.js";

// Relógio dos testes: 2026-11-05 12:00Z = 09:00 em São Paulo.
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock() } as unknown as Ports, ...over });
const briefSet = (agenda: FakeAgenda) => createAgendaCapability(agenda).tools.find((t) => t.name === "brief_set")!;

describe("brief_set: criar o plano do dia pelo chat", () => {
	it("'todo dia às 7h30': horário exato, próximo 07:30 (amanhã, pois hoje já passou das 09:00), recorrência diária", async () => {
		const agenda = new FakeAgenda();
		const out = await briefSet(agenda).run({ time: "07:30" }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { externalId: "ag-1", where: "Agenda" } });
		expect(out.ok && out.summary).toContain("every day at 07:30 (America/Sao_Paulo), next one 2026-11-06 07:30");
		expect([...agenda.items.values()][0]).toMatchObject({ kind: "brief", userId: "o1", everyMinutes: 1440, maxRuns: null, untilAt: null, nextRunAt: "2026-11-06T10:30:00.000Z", note: BRIEF_DEFAULT_NOTE });
	});
	it("se o horário ainda não passou hoje, o primeiro é hoje (18:00 > 09:00)", async () => {
		const agenda = new FakeAgenda();
		await briefSet(agenda).run({ time: "18:00" }, ctx());
		expect([...agenda.items.values()][0]!.nextRunAt).toBe("2026-11-05T21:00:00.000Z");
	});
	it("um por dono: pedir de novo ATUALIZA horário e foco em vez de duplicar", async () => {
		const agenda = new FakeAgenda();
		const tool = briefSet(agenda);
		await tool.run({ time: "07:30" }, ctx());
		const again = await tool.run({ time: "06:45", focus: "só aulas, sem e-mails" }, ctx({ runId: "run-2" }));
		expect(again.ok && again.summary).toContain("Updated the existing daily plan");
		expect(again).toMatchObject({ receipt: { what: "Agenda: daily plan updated" } });
		expect(agenda.items.size).toBe(1);
		const item = [...agenda.items.values()][0]!;
		expect(item.nextRunAt).toBe("2026-11-06T09:45:00.000Z");
		expect(item.note).toContain("Owner's focus: só aulas, sem e-mails");
	});
	it("o plano de outro dono não é tocado nem visto (IDOR)", async () => {
		const agenda = new FakeAgenda();
		const tool = briefSet(agenda);
		await tool.run({ time: "07:30" }, ctx({ ownerId: "alice" }));
		const bob = await tool.run({ time: "08:00" }, ctx({ ownerId: "bob" }));
		expect(bob.ok && bob.summary).toContain("Scheduled the daily plan");
		expect(agenda.items.size).toBe(2);
		expect([...agenda.items.values()].map((i) => [i.userId, i.nextRunAt])).toEqual([["alice", "2026-11-06T10:30:00.000Z"], ["bob", "2026-11-06T11:00:00.000Z"]]);
	});
	it("hora inválida é recusada com a forma aceita; nada é criado", async () => {
		const agenda = new FakeAgenda();
		for (const time of ["25:00", "7h30", "abc", "07:60"]) {
			const out = await briefSet(agenda).run({ time }, ctx());
			expect(out.ok, time).toBe(false);
		}
		expect(agenda.items.size).toBe(0);
	});
	it("o plano aparece em agenda_list e se cancela por agenda_change", async () => {
		const agenda = new FakeAgenda();
		const tools = Object.fromEntries(createAgendaCapability(agenda).tools.map((t) => [t.name, t]));
		await tools.brief_set!.run({ time: "07:30" }, ctx());
		const list = await tools.agenda_list!.run({}, ctx());
		expect(list.ok && list.summary).toContain("brief");
		expect(await tools.agenda_change!.run({ id: "ag-1", action: "cancel" }, ctx())).toMatchObject({ ok: true });
		expect((await tools.agenda_list!.run({}, ctx())).ok && (await tools.agenda_list!.run({}, ctx())).ok).toBe(true);
	});
});
