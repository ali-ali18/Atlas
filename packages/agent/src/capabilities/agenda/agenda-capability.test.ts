import { describe, expect, it } from "vitest";
import { FakeAgenda } from "../../presets/fakes.js";
import { FakeClock } from "../../testing/fake-ports.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import type { Ports } from "../../ports/index.js";
import type { ToolContext } from "../../tools/types.js";
import { createAgendaCapability, createAgendaRunCapability } from "./agenda-capability.js";

// O relógio dos testes é 2026-11-05 12:00Z = 09:00 em São Paulo (silêncio 22:00 a 08:00).
const ctx = (ownerId = "o1", runId = "run-1"): ToolContext => ({ runId, ownerId, ports: { clock: new FakeClock() } as unknown as Ports });
const tools = (agenda: FakeAgenda) => Object.fromEntries(createAgendaCapability(agenda).tools.map((t) => [t.name, t]));

describe("capacidade agenda: criação", () => {
	it("é lazy e as tools de criação são write_internal (silenciosas em autonomia normal)", () => {
		const cap = createAgendaCapability(new FakeAgenda());
		expect(cap.core).toBe(false);
		expect(cap.tools.map((t) => t.name)).toEqual(["remind_me", "watch", "on_event", "agenda_list", "agenda_change"]);
		for (const name of ["remind_me", "watch", "on_event", "agenda_change"]) expect(cap.tools.find((t) => t.name === name)).toMatchObject({ effect: "write_internal", egress: false, trust: "trusted" });
		expect(cap.tools.find((t) => t.name === "agenda_list")?.effect).toBe("read");
	});

	it("remind_me agenda no fuso do dono, devolve o horário e um recibo", async () => {
		const agenda = new FakeAgenda();
		const out = await tools(agenda).remind_me!.run({ note: "Ligar para o contador", when: "2026-11-06T10:00" }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { what: "Agenda: reminder scheduled", where: "Agenda", externalId: "ag-1" } });
		expect(out.ok && out.summary).toContain("first run 2026-11-06 10:00 (America/Sao_Paulo)");
		expect(out.ok && out.summary).toContain("silent");
		expect([...agenda.items.values()][0]).toMatchObject({ kind: "remind", userId: "o1", maxRuns: 1, everyMinutes: null });
	});

	it("diz quando ajustou: horário dentro do silêncio vai para a manhã", async () => {
		const out = await tools(new FakeAgenda()).remind_me!.run({ note: "x", when: "2026-11-05T23:30" }, ctx());
		expect(out.ok && out.summary).toContain("first run 2026-11-06 08:00");
		expect(out.ok && out.summary).toContain("moved out of the owner's quiet hours");
	});

	it("watch: intervalo abaixo de 2h falha com a regra; com o pedido explícito declarado passa; vigia sem fim ganha 14 dias", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		const short = await t.watch!.run({ note: "preço", everyMinutes: 30 }, ctx());
		expect(short).toMatchObject({ ok: false, error: expect.stringContaining("explicitly asked") });
		expect(agenda.items.size).toBe(0);
		const asked = await t.watch!.run({ note: "preço", everyMinutes: 30, ownerAskedShortInterval: true }, ctx());
		expect(asked.ok).toBe(true);
		const open = await t.watch!.run({ note: "entrega do pedido", everyMinutes: 360 }, ctx());
		expect(open.ok && open.summary).toContain("stops after 14 days");
		expect([...agenda.items.values()].at(-1)?.untilAt).toBe("2026-11-19T12:00:00.000Z");
	});

	it("pedido repetido não cria outro item e diz isso; ao passar de 20 itens ativos, erro com a saída", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		await t.watch!.run({ note: "Preço do notebook", everyMinutes: 120 }, ctx());
		const again = await t.watch!.run({ note: "preço do notebook", everyMinutes: 120 }, ctx());
		expect(again.ok && again.summary).toContain("Already scheduled (nothing new created)");
		expect(agenda.items.size).toBe(1);
		for (let i = 0; i < 19; i++) await t.watch!.run({ note: `acompanhar coisa distinta numero ${i}`, everyMinutes: 120 }, ctx());
		const over = await t.watch!.run({ note: "mais um item", everyMinutes: 120 }, ctx());
		expect(over).toMatchObject({ ok: false, error: expect.stringContaining("20 active"), hint: expect.stringContaining("agenda_list") });
	});

	it("on_event monta o filtro dos campos declarados; campo desconhecido e filtro vazio falham", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		const ok = await t.on_event!.run({ note: "Resumir a fatura", source: "email", from: "banco.com", subjectContains: "fatura" }, ctx());
		expect(ok.ok && ok.summary).toContain("valid until");
		expect([...agenda.items.values()][0]).toMatchObject({ kind: "intent", eventFilter: { source: "email", from: "banco.com", subjectContains: "fatura" } });
		expect(await t.on_event!.run({ note: "x", source: "email", from: "a.com", regex: ".*" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field") });
		expect(await t.on_event!.run({ note: "x", source: "email" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("at least one criterion") });
		expect(await t.on_event!.run({ note: "x", source: "sms", from: "a" }, ctx())).toMatchObject({ ok: false });
	});

	it("erros de planejamento voltam para o modelo e nada é criado", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		expect(await t.remind_me!.run({ note: "x", when: "2020-01-01T10:00" }, ctx())).toMatchObject({ ok: false });
		expect(await t.remind_me!.run({ note: "x", when: "2026-11-06T10:00", maxRuns: 3 }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("recurring") });
		expect(await t.remind_me!.run({ note: "x" }, ctx())).toMatchObject({ ok: false });
		expect(agenda.items.size).toBe(0);
	});
});

describe("capacidade agenda: listar e mudar (só o que é do dono)", () => {
	it("agenda_list mostra id, próximo horário e estado; vazia diz isso", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		expect((await t.agenda_list!.run({}, ctx())).ok).toBe(true);
		expect(await t.agenda_list!.run({}, ctx())).toMatchObject({ summary: "No active agenda items." });
		await t.remind_me!.run({ note: "Ligar para a Ana", when: "2026-11-06T10:00" }, ctx());
		const out = await t.agenda_list!.run({}, ctx());
		expect(out.ok && out.summary).toContain("id ag-1 | remind | pending | next 2026-11-06 10:00");
		expect(out.ok && out.summary).toContain("Ligar para a Ana");
	});

	it("pausar, retomar e cancelar; estado que não cabe na ação é erro honesto", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		await t.watch!.run({ note: "vigia", everyMinutes: 120 }, ctx());
		expect(await t.agenda_change!.run({ id: "ag-1", action: "resume" }, ctx())).toMatchObject({ ok: false });
		expect(await t.agenda_change!.run({ id: "ag-1", action: "pause" }, ctx())).toMatchObject({ ok: true, summary: "Paused watch ag-1." });
		expect(agenda.items.get("ag-1")?.status).toBe("paused");
		expect(await t.agenda_change!.run({ id: "ag-1", action: "resume" }, ctx())).toMatchObject({ ok: true });
		expect(await t.agenda_change!.run({ id: "ag-1", action: "cancel" }, ctx())).toMatchObject({ ok: true, receipt: { externalId: "ag-1" } });
		expect(await t.agenda_change!.run({ id: "ag-1", action: "pause" }, ctx())).toMatchObject({ ok: false });
		const ended = await t.agenda_list!.run({ includeEnded: true }, ctx());
		expect(ended.ok && ended.summary).toContain("cancelled");
		expect(ended.ok && ended.summary).toContain("ended: owner");
	});

	it("outro dono: não vê, não pausa nem cancela, e a resposta é a mesma de item que não existe", async () => {
		const agenda = new FakeAgenda();
		const t = tools(agenda);
		await t.watch!.run({ note: "segredo do A", everyMinutes: 120 }, ctx("A"));
		const listB = await t.agenda_list!.run({}, ctx("B"));
		expect(listB.ok && listB.summary).toBe("No active agenda items.");
		const foreign = await t.agenda_change!.run({ id: "ag-1", action: "cancel" }, ctx("B"));
		const missing = await t.agenda_change!.run({ id: "ag-999", action: "cancel" }, ctx("B"));
		expect(foreign).toMatchObject({ ok: false });
		expect(!foreign.ok && foreign.error).toBe(!missing.ok ? missing.error.replace("ag-999", "ag-1") : "");
		expect(agenda.items.get("ag-1")?.status).toBe("pending");
		// o item do A não aceita resultado vindo de run do B
		agenda.startRun("A", "ag-1", "run-a");
		expect(await agenda.reportResult("B", "run-a", { outcome: "done" })).toMatchObject({ ok: false });
	});
});

describe("agenda_result (capacidade só dos runs de agenda)", () => {
	const setup = () => {
		const agenda = new FakeAgenda();
		agenda.items.set("ag-1", { id: "ag-1", userId: "o1", kind: "watch", status: "pending", note: "n", nextRunAt: "2026-11-05T12:00:00.000Z", everyMinutes: 120, untilAt: null, runCount: 0, maxRuns: null, eventFilter: null, endReason: null });
		agenda.startRun("o1", "ag-1", "run-1");
		const cap = createAgendaRunCapability(agenda);
		return { agenda, cap, tool: cap.tools[0]! };
	};

	it("é núcleo do run de agenda e encerra o run", () => {
		const { cap, tool } = setup();
		expect(cap).toMatchObject({ id: "agenda-run", core: true });
		expect(tool).toMatchObject({ name: "agenda_result", endsRun: true, effect: "write_internal" });
	});

	it("no_change grava sem mensagem e avisa que nada será postado; mensagem em no_change é recusada", async () => {
		const { agenda, tool } = setup();
		expect(await tool.run({ outcome: "no_change", message: "nada de novo" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("must not carry a message") });
		expect(agenda.results).toHaveLength(0);
		const ok = await tool.run({ outcome: "no_change", memo: "R$ 4.990" }, ctx());
		expect(ok.ok && ok.summary).toContain("nothing will be posted");
		expect(agenda.results[0]).toMatchObject({ runId: "run-1", result: { outcome: "no_change", memo: "R$ 4.990" } });
	});

	it("update exige a mensagem; pendência do dono exige update", async () => {
		const { agenda, tool } = setup();
		expect(await tool.run({ outcome: "update" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("needs a message") });
		expect(await tool.run({ outcome: "no_change", pending: ["aprovar o envio"] }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("owner must hear") });
		const ok = await tool.run({ outcome: "update", message: "Caiu para R$ 4.200.", pending: ["aprovar a compra"] }, ctx());
		expect(ok.ok && ok.summary).toContain("the message will be delivered");
		expect(agenda.results[0]?.result).toMatchObject({ outcome: "update", message: "Caiu para R$ 4.200.", pending: ["aprovar a compra"] });
	});

	it("done encerra o item; run de outro dono ou sem item é erro real", async () => {
		const { agenda, tool } = setup();
		expect(await tool.run({ outcome: "done", message: "Chegou, encerrei." }, ctx())).toMatchObject({ ok: true });
		expect(agenda.items.get("ag-1")?.status).toBe("done");
		expect(await tool.run({ outcome: "done" }, ctx("outro"))).toMatchObject({ ok: false, hint: expect.stringContaining("woken by the agenda") });
		expect(await tool.run({ outcome: "done" }, ctx("o1", "run-sem-item"))).toMatchObject({ ok: false });
	});

	it("valida enum, campo desconhecido e tamanho", async () => {
		const { tool } = setup();
		expect(await tool.run({ outcome: "maybe" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("no_change") });
		expect(await tool.run({ outcome: "done", extra: 1 }, ctx())).toMatchObject({ ok: false });
		expect((await tool.run({ outcome: "update", message: "a".repeat(2001) }, ctx())).ok).toBe(false);
	});
});

describe("agenda no kernel", () => {
	const ownerCtx = { surface: "chat" as const, ownerPresent: true, autonomy: "balanced" as const, rules: [] };

	it("chat: o modelo carrega a capacidade e agenda sem nenhum cartão de aprovação", async () => {
		const agenda = new FakeAgenda();
		const h = kernelHarness(
			[
				reply({ calls: [call("a", "use_capability", { id: "agenda" })] }),
				reply({ calls: [call("b", "remind_me", { note: "Perguntar se a entrega chegou", when: "2026-11-07T10:00" })] }),
				reply({ text: "Combinado, te lembro sexta às 10h." }),
			],
			{ capabilities: [createAgendaCapability(agenda)] },
		);
		const result = await h.run({ policy: ownerCtx });
		expect(result.status).toBe("done");
		expect(h.llm.requests[0]?.tools?.map((t) => t.name)).not.toContain("remind_me");
		expect(h.llm.requests[1]?.tools?.map((t) => t.name)).toContain("remind_me");
		expect(agenda.items.size).toBe(1);
		expect(h.log.events.some((e) => e.type === "card")).toBe(false);
	});

	it("run de agenda (sem dono): agenda_result está carregada desde o início e fecha o run sem texto ao dono", async () => {
		const agenda = new FakeAgenda();
		agenda.items.set("ag-1", { id: "ag-1", userId: "owner-1", kind: "watch", status: "pending", note: "n", nextRunAt: "2026-11-05T12:00:00.000Z", everyMinutes: 120, untilAt: null, runCount: 0, maxRuns: null, eventFilter: null, endReason: null });
		agenda.startRun("owner-1", "ag-1", "run-1");
		const h = kernelHarness([reply({ calls: [call("a", "agenda_result", { outcome: "no_change", memo: "igual" })] })], { capabilities: [createAgendaRunCapability(agenda)] });
		const result = await h.run({ policy: { surface: "agenda", ownerPresent: false, autonomy: "balanced", rules: [] }, askOwner: false });
		expect(result.status).toBe("done");
		expect(h.llm.requests[0]?.tools?.map((t) => t.name)).toContain("agenda_result");
		expect(h.llm.requests).toHaveLength(1);
		expect(agenda.results).toHaveLength(1);
	});
});
