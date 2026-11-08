import { describe, expect, it } from "vitest";
import { planAgendaItem, DEFAULT_PROACTIVE_SETTINGS } from "@workspace/shared";
import { agendaRunPolicy, buildAgendaWake } from "../../agenda/wake.js";
import { FakeAgenda, FakeCalendar, FakeNotebook } from "../../presets/fakes.js";
import type { BriefCardPayload, BriefEmailItem, BriefPorts } from "../../ports/brief.js";
import { CalendarNotConnectedError } from "../../ports/calendar.js";
import type { Ports } from "../../ports/index.js";
import { FakeClock } from "../../testing/fake-ports.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import type { ToolContext } from "../../tools/types.js";
import { createAgendaRunCapability } from "../agenda/index.js";
import { createBriefCapability } from "./index.js";

// Relógio dos testes: 2026-11-05 12:00Z = quinta 09:00 em São Paulo.
const NOW = new Date("2026-11-05T12:00:00.000Z");
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock() } as unknown as Ports, ...over });

const mail = (over: Partial<BriefEmailItem> & Pick<BriefEmailItem, "id">): BriefEmailItem => ({ from: "Contador <contador@example.com>", subject: "Recibo", receivedAt: "2026-11-05T08:00:00.000Z", ...over });

function rig(options: { email?: BriefEmailItem[] | Error; withEmail?: boolean; cards?: boolean } = {}) {
	const agenda = new FakeAgenda();
	const calendar = new FakeCalendar();
	const notebook = new FakeNotebook();
	const shown: Array<{ userId: string; runId: string; card: BriefCardPayload }> = [];
	const emailCalls: Array<{ userId: string; since: string; limit: number }> = [];
	const ports: BriefPorts = {
		agenda,
		calendar: calendar.ports.calendar,
		notebook,
		tasks: { list: async (userId) => (userId === "o1" ? ["Enviar o relatório", "Marcar o dentista"] : ["tarefa de outro dono"]) },
		deliveries: { listTracked: async (userId) => (userId === "o1" ? [{ merchant: "Loja A", items: ["Fone X"], purchasedAt: "2026-11-01T12:00:00.000Z", orderNumber: "A-10", trackingCode: "BR123" }] : []) },
		...(options.withEmail !== false && {
			email: {
				listRecent: async (userId, o) => {
					emailCalls.push({ userId, since: o.since, limit: o.limit });
					if (options.email instanceof Error) throw options.email;
					return userId === "o1" ? (options.email ?? []) : [mail({ id: "outro", subject: "E-mail DE OUTRO DONO", category: "action" })];
				},
			},
		}),
		...(options.cards !== false && { cards: { show: async (userId, runId, card) => void shown.push({ userId, runId, card }) } }),
	};
	const cap = createBriefCapability(ports);
	const tool = (name: string) => cap.tools.find((t) => t.name === name)!;
	return { agenda, calendar, notebook, ports, cap, tool, shown, emailCalls };
}

/** Item de brief ligado ao run (como a varredura faz ao acordar). */
function wakeBrief(agenda: FakeAgenda, userId = "o1", runId = "run-1") {
	const planned = planAgendaItem({ request: { kind: "brief", note: "Plano do dia", when: "2026-11-06T07:30" }, now: NOW, settings: { ...DEFAULT_PROACTIVE_SETTINGS, timezone: "America/Sao_Paulo" } });
	if (!planned.ok) throw new Error(planned.error);
	return agenda.create(userId, planned.plan, { sourceRunId: "chat" }).then((created) => {
		if (!created.ok) throw new Error(created.error);
		agenda.startRun(userId, created.item.id, runId);
		return created.item;
	});
}

describe("capacidade brief: forma", () => {
	it("é núcleo do run do brief; brief_sources lê (dado de terceiros, privado) e day_plan fecha o run", () => {
		const { cap, tool } = rig();
		expect(cap.core).toBe(true);
		expect(cap.cards).toEqual(["day-plan"]);
		expect(cap.tools.map((t) => t.name)).toEqual(["brief_sources", "day_plan"]);
		expect(tool("brief_sources")).toMatchObject({ effect: "read", trust: "untrusted", source: "mcp", privateData: true, ownerData: "connector", egress: false });
		expect(tool("day_plan")).toMatchObject({ effect: "write_internal", endsRun: true });
	});
});

describe("brief_sources", () => {
	it("reúne agenda do dia, e-mails que pedem ação (com prazo), lembretes, caderno, tarefas e entregas", async () => {
		const r = rig({ email: [mail({ id: "1", subject: "Enviar recibo até sexta", category: "action", dueAt: "2026-11-06T20:00:00.000Z", requestedBy: "Contador" }), mail({ id: "2", subject: "Newsletter", category: "info" }), mail({ id: "3", subject: "Promoção", category: "ignore" }), mail({ id: "4", subject: "Sem classificação" })] });
		r.calendar.seed("o1", { title: "Reunião de produto", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", location: "Sala 2", attendees: ["ana@example.com"] });
		r.calendar.seed("o1", { title: "Amanhã", start: "2026-11-06T17:00:00.000Z", end: "2026-11-06T18:00:00.000Z" });
		await r.notebook.add("o1", { layer: "owner", title: "Prova de cálculo dia 12", body: "x", pinned: true });
		await r.agenda.create("o1", { kind: "remind", note: "Ligar para o contador", dueAt: new Date("2026-11-05T18:00:00.000Z"), requestedFor: new Date("2026-11-05T18:00:00.000Z"), intervalMinutes: null, untilAt: null, maxRuns: 1, eventFilter: null, adjustments: [] }, { sourceRunId: "x" });
		await r.agenda.create("o1", { kind: "remind", note: "Só na semana que vem", dueAt: new Date("2026-11-12T18:00:00.000Z"), requestedFor: new Date("2026-11-12T18:00:00.000Z"), intervalMinutes: null, untilAt: null, maxRuns: 1, eventFilter: null, adjustments: [] }, { sourceRunId: "x" });

		const out = await r.tool("brief_sources").run({}, ctx());
		expect(out.ok).toBe(true);
		const text = out.ok ? out.summary : "";
		expect(text).toContain("Now: 2026-11-05 09:00 (Thursday, America/Sao_Paulo). Plan for 2026-11-05.");
		expect(text).toContain("== CALENDAR (today)\n- 2026-11-05 14:00–15:00 | Reunião de produto @ Sala 2 | 1 guests");
		expect(text).not.toContain("Amanhã");
		expect(text).toContain("from Contador <contador@example.com> | Enviar recibo até sexta | due 2026-11-06T20:00:00.000Z | asked by Contador | needs action");
		expect(text).toContain("Sem classificação");
		expect(text).toContain("not classified");
		expect(text).toContain("1 other message marked as just to know (not listed)");
		expect(text).not.toContain("Promoção");
		expect(text).not.toContain("Newsletter");
		expect(text).toContain("Ligar para o contador");
		expect(text).not.toContain("Só na semana que vem");
		expect(text).toContain("Prova de cálculo dia 12");
		expect(text).toContain("Enviar o relatório");
		expect(text).toContain("Loja A | Fone X | order A-10 | tracking BR123");
		expect(text).not.toContain("COULD NOT BE READ");
		// janela de 24 h e limite pedidos ao e-mail
		expect(r.emailCalls).toEqual([{ userId: "o1", since: "2026-11-04T12:00:00.000Z", limit: 30 }]);
	});
	it("o brief funciona SEM a porta de e-mail (outra frente): a seção some, sem erro", async () => {
		const r = rig({ withEmail: false });
		r.calendar.seed("o1", { title: "Dentista", start: "2026-11-05T19:00:00.000Z", end: "2026-11-05T20:00:00.000Z" });
		const out = await r.tool("brief_sources").run({}, ctx());
		expect(out.ok && out.summary).toContain("Dentista");
		expect(out.ok && out.summary).not.toContain("== EMAIL");
		expect(out.ok && out.summary).not.toContain("COULD NOT BE READ");
	});
	it("fonte com falha vira dado e as outras seguem: agenda caída não derruba o brief", async () => {
		const r = rig({ email: [mail({ id: "1", subject: "Prazo", category: "action" })] });
		r.calendar.fail = new Error("Google respondeu 500");
		const out = await r.tool("brief_sources").run({}, ctx());
		expect(out.ok && out.summary).toContain("Prazo");
		expect(out.ok && out.summary).toContain("SOURCES THAT COULD NOT BE READ: calendar.");
		expect(out.ok && out.summary).not.toContain("== CALENDAR");
		expect(out.ok && out.summary).not.toContain("Google respondeu 500");
	});
	it("login expirado (code needs_connection) é distinguido de falha qualquer", async () => {
		const r = rig({ email: Object.assign(new Error("token expirado"), { code: "needs_connection" }) });
		await wakeBrief(r.agenda);
		r.calendar.fail = new CalendarNotConnectedError();
		const out = await r.tool("brief_sources").run({}, ctx());
		expect(out.ok && out.summary).toContain("calendar (login expired), email (login expired)");
		const plan = await r.tool("day_plan").run({ headline: "x" }, ctx());
		expect(plan.ok).toBe(true);
		expect(r.shown[0]!.card.sourceErrors).toEqual([{ source: "calendar", reason: "needs_connection" }, { source: "email", reason: "needs_connection" }]);
	});
	it("NUNCA conectado (not_connected) é fonte ausente: sem seção, sem linha de aviso, sem 'reconecte'; só login expirado avisa", async () => {
		const r = rig({ email: Object.assign(new Error("No e-mail account is connected."), { code: "not_connected" }) });
		await wakeBrief(r.agenda);
		r.calendar.fail = new CalendarNotConnectedError(undefined, "never");
		const out = await r.tool("brief_sources").run({}, ctx());
		expect(out.ok && out.summary).not.toContain("== CALENDAR");
		expect(out.ok && out.summary).not.toContain("== EMAIL");
		expect(out.ok && out.summary).not.toContain("COULD NOT BE READ");
		expect(out.ok && out.summary).not.toContain("login expired");
		const plan = await r.tool("day_plan").run({ headline: "x" }, ctx());
		expect(plan.ok).toBe(true);
		expect(r.shown[0]!.card.sourceErrors ?? []).toEqual([]);
		// Misto: agenda nunca conectada some; e-mail com login expirado continua avisando.
		const mixed = rig({ email: Object.assign(new Error("token expirado"), { code: "needs_connection" }) });
		await wakeBrief(mixed.agenda);
		mixed.calendar.fail = new CalendarNotConnectedError(undefined, "never");
		const both = await mixed.tool("brief_sources").run({}, ctx());
		expect(both.ok && both.summary).toContain("COULD NOT BE READ: email (login expired).");
		expect(both.ok && both.summary).not.toContain("calendar");
	});
	it("só lê o que é do dono do run: nada de outro dono entra (IDOR)", async () => {
		const r = rig({ email: [mail({ id: "1", subject: "Meu e-mail", category: "action" })] });
		r.calendar.seed("alice", { title: "Segredo da Alice", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z" });
		const out = await r.tool("brief_sources").run({}, ctx({ ownerId: "bob" }));
		expect(out.ok && out.summary).not.toContain("Segredo da Alice");
		expect(out.ok && out.summary).not.toContain("Meu e-mail");
		expect(out.ok && out.summary).toContain("E-mail DE OUTRO DONO");
		expect(out.ok && out.summary).not.toContain("Enviar o relatório");
		expect(r.emailCalls.map((c) => c.userId)).toEqual(["bob"]);
	});
});

describe("day_plan", () => {
	it("exige ler as fontes antes (nunca monta plano no escuro)", async () => {
		const r = rig();
		await wakeBrief(r.agenda);
		expect(await r.tool("day_plan").run({ headline: "x" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("not read"), hint: expect.stringContaining("brief_sources") });
		expect(r.shown).toEqual([]);
		expect(r.agenda.results).toEqual([]);
	});
	it("posta UM cartão (seção vazia some), com as falhas do coletor, e fecha o item com a frase como mensagem", async () => {
		const r = rig({ email: [mail({ id: "1", subject: "Prazo", category: "action" })] });
		await wakeBrief(r.agenda);
		r.calendar.fail = new Error("Google caiu");
		await r.tool("brief_sources").run({}, ctx());
		const out = await r.tool("day_plan").run({ headline: "Hoje: 1 e-mail pede ação.", emails: [{ text: "Contador pede o recibo", detail: "prazo sexta" }], pending: [], commitments: [], deliveries: [{ text: "Fone X chega hoje" }] }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { what: "Day plan posted" } });
		expect(out.ok && out.summary).toContain("sections: emails, deliveries; could not read: calendar");
		expect(r.shown).toHaveLength(1);
		expect(r.shown[0]!.card).toMatchObject({ planId: "day-plan:run-1", date: "2026-11-05", timeZone: "America/Sao_Paulo", headline: "Hoje: 1 e-mail pede ação.", sourceErrors: [{ source: "calendar", reason: "failed" }] });
		expect(r.shown[0]!.card.sections.map((s) => s.id)).toEqual(["emails", "deliveries"]);
		expect(r.agenda.results).toEqual([{ userId: "o1", runId: "run-1", result: { outcome: "update", message: "Hoje: 1 e-mail pede ação." }, untrustedRead: false }]);
	});
	it("o modelo NÃO declara as falhas: o que ele escrever sobre isso não vira dado, e campo desconhecido é erro", async () => {
		const r = rig();
		await wakeBrief(r.agenda);
		await r.tool("brief_sources").run({}, ctx());
		expect(await r.tool("day_plan").run({ headline: "x", sourceErrors: [{ source: "calendar", reason: "failed" }] }, ctx())).toMatchObject({ ok: false });
		expect(await r.tool("day_plan").run({ headline: "x", pending: [{ text: "a", time: "09:00" }] }, ctx())).toMatchObject({ ok: false });
	});
	it("dia livre também posta (é o pedido do dono): só a frase, sem seções", async () => {
		const r = rig({ email: [] });
		await wakeBrief(r.agenda);
		await r.tool("brief_sources").run({}, ctx());
		const out = await r.tool("day_plan").run({ headline: "Dia livre: nada marcado." }, ctx());
		expect(out.ok && out.summary).toContain("sections: none");
		expect(r.shown[0]!.card.sections).toEqual([]);
		expect(r.agenda.results[0]!.result).toMatchObject({ outcome: "update", message: "Dia livre: nada marcado." });
	});
	it("lista grande demais é recusada com o limite (não corta em silêncio)", async () => {
		const r = rig();
		await wakeBrief(r.agenda);
		await r.tool("brief_sources").run({}, ctx());
		const out = await r.tool("day_plan").run({ headline: "x", commitments: Array.from({ length: 9 }, (_, i) => ({ text: `c${i}` })) }, ctx());
		expect(out.ok).toBe(false);
	});
	it("sem a porta de cartões o plano chega como texto (frase + itens), nunca se perde", async () => {
		const r = rig({ cards: false });
		await wakeBrief(r.agenda);
		await r.tool("brief_sources").run({}, ctx());
		await r.tool("day_plan").run({ headline: "Hoje: 1 compromisso.", commitments: [{ text: "Reunião", time: "14:00" }] }, ctx());
		expect(r.agenda.results[0]!.result.message).toBe("Hoje: 1 compromisso.\n- 14:00 Reunião");
	});
	it("fora de um run de agenda (sem item ligado ao run) é erro real e não deixa cartão órfão de outro dono", async () => {
		const r = rig();
		await r.tool("brief_sources").run({}, ctx({ runId: "run-chat" }));
		const out = await r.tool("day_plan").run({ headline: "x" }, ctx({ runId: "run-chat" }));
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("No agenda item") });
	});
	it("o resultado do brief de um dono não fecha o item de outro", async () => {
		const r = rig();
		await wakeBrief(r.agenda, "alice", "run-alice");
		await r.tool("brief_sources").run({}, ctx({ ownerId: "bob", runId: "run-alice" }));
		const out = await r.tool("day_plan").run({ headline: "x" }, ctx({ ownerId: "bob", runId: "run-alice" }));
		expect(out.ok).toBe(false);
		expect(r.agenda.results).toEqual([]);
	});
});

describe("run do brief ponta a ponta (kernel, sem dono, só leitura)", () => {
	it("acorda, lê as fontes, posta o cartão e termina; nada é escrito fora", async () => {
		const r = rig({ email: [mail({ id: "1", subject: "Prazo", category: "action", dueAt: "2026-11-06T20:00:00.000Z" })] });
		const item = await wakeBrief(r.agenda);
		r.calendar.seed("o1", { title: "Reunião de produto", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z" });
		const wake = buildAgendaWake({ item: { kind: "brief", note: "Plano do dia", runCount: 1, maxRuns: null, untilAt: null, grant: null }, now: NOW, timeZone: "America/Sao_Paulo" });
		expect(wake.history[0]!.text).toContain("Call brief_sources once, then finish with day_plan");
		expect(wake.history[0]!.text).toContain("do not call agenda_result");
		expect(wake.history[0]!.text).not.toContain("End with agenda_result exactly once");
		const h = kernelHarness(
			[
				reply({ calls: [call("a", "brief_sources", {})] }),
				reply({ calls: [call("b", "day_plan", { headline: "Hoje: 1 compromisso e 1 e-mail com prazo.", commitments: [{ text: "Reunião de produto", time: "14:00" }], emails: [{ text: "Prazo", detail: "sexta" }] })] }),
			],
			{ capabilities: [r.cap, createAgendaRunCapability(r.agenda)] },
		);
		const result = await h.run({ ownerId: "o1", policy: agendaRunPolicy(null), askOwner: false, input: { contextSections: [], history: wake.history, ...(wake.provenance && { priorProvenance: wake.provenance }) } });
		expect(result.status).toBe("done");
		expect(r.shown).toHaveLength(1);
		expect(r.agenda.results).toHaveLength(1);
		expect(r.agenda.results[0]!.result.outcome).toBe("update");
		expect(item.id).toBe("ag-1");
		// O primeiro passo só oferece as tools do brief, o fechamento da agenda e as do próprio kernel: nada de escrita no mundo.
		expect(h.llm.requests[0]?.tools?.map((t) => t.name).sort()).toEqual(["agenda_result", "brief_sources", "day_plan", "note_read", "use_capability"]);
	});
});

