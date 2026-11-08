import { describe, expect, it } from "vitest";
import { agendaRunPolicy } from "../../agenda/wake.js";
import { chatPolicy, setup } from "../../testing/contract-helpers.js";
import { FakeCalendar, FakeSearch, FakeFileStore } from "../../presets/fakes.js";
import { setupPreset } from "../../presets/presets.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { Ports } from "../../ports/index.js";
import { CalendarNotConnectedError } from "../../ports/calendar.js";
import type { ToolContext } from "../../tools/types.js";
import { createCalendarCapability } from "./index.js";

// Relógio dos testes: 2026-11-05 12:00Z = quinta 09:00 em São Paulo.
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock() } as unknown as Ports, ...over });

function rig() {
	const fake = new FakeCalendar();
	const cap = createCalendarCapability(fake.ports);
	const tool = (name: string) => cap.tools.find((t) => t.name === name)!;
	return { fake, cap, tool };
}

// 14:00–15:00 em São Paulo
const MEETING = { title: "Reunião de produto", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", location: "Sala 2" };

describe("capacidade calendar: forma", () => {
	it("é lazy, declara o cartão e cada tool tem o efeito certo", () => {
		const { cap, tool } = rig();
		expect(cap.core).toBe(false);
		expect(cap.cards).toEqual(["calendar"]);
		expect(cap.tools.map((t) => t.name)).toEqual(["calendar_list", "calendar_get", "calendar_create", "calendar_update", "calendar_delete"]);
		for (const name of ["calendar_list", "calendar_get"]) expect(tool(name)).toMatchObject({ effect: "read", trust: "untrusted", source: "mcp", privateData: true, ownerData: "connector" });
		expect(tool("calendar_create")).toMatchObject({ effect: "write_external" });
		expect(tool("calendar_update")).toMatchObject({ effect: "write_external" });
		expect(tool("calendar_delete")).toMatchObject({ effect: "destructive", confirm: "always" });
	});
	it("com convidados o efeito é send (o Google manda o convite); sem convidados e sem aviso, não", () => {
		const { tool } = rig();
		expect(tool("calendar_create").effectFor({ title: "x", start: "2026-11-06T10:00" })).toBe("write_external");
		expect(tool("calendar_create").effectFor({ title: "x", start: "2026-11-06T10:00", attendees: ["ana@example.com"] })).toBe("send");
		expect(tool("calendar_update").effectFor({ eventId: "e", title: "y" })).toBe("write_external");
		expect(tool("calendar_update").effectFor({ eventId: "e", attendees: ["ana@example.com"] })).toBe("send");
		expect(tool("calendar_update").effectFor({ eventId: "e", notifyGuests: true })).toBe("send");
		expect(tool("calendar_update").effectFor({ eventId: "e", notifyGuests: false })).toBe("write_external");
	});
	it("riskFacts de convite listam os destinatários (todos externos)", () => {
		const { tool } = rig();
		expect(tool("calendar_create").riskFactsFor({ title: "Almoço", start: "2026-11-06T12:00", attendees: ["ana@example.com", "bia@example.com"] })).toMatchObject({ recipients: ["ana@example.com", "bia@example.com"], externalRecipients: ["ana@example.com", "bia@example.com"] });
		expect(tool("calendar_create").riskFactsFor({ title: "Almoço", start: "2026-11-06T12:00" })?.recipients).toBeUndefined();
	});
	it("run de agenda (readOnly): só lê, sem cartão e a instrução não promete escrita", () => {
		const fake = new FakeCalendar();
		const cap = createCalendarCapability({ ...fake.ports, readOnly: true });
		expect(cap.tools.map((t) => t.name)).toEqual(["calendar_list", "calendar_get"]);
		expect(cap.instructions).toContain("only reads");
		expect(cap.instructions).not.toContain("Inviting");
	});
});

describe("calendar_list", () => {
	it("diz a data de agora e o fuso do dono (o modelo não sabe a data), lista o dia e mostra o cartão", async () => {
		const { fake, tool } = rig();
		fake.seed("o1", MEETING);
		fake.seed("o1", { title: "Amanhã cedo", start: "2026-11-06T11:00:00.000Z", end: "2026-11-06T12:00:00.000Z" });
		const out = await tool("calendar_list").run({}, ctx());
		expect(out.ok && out.summary).toContain("Now: 2026-11-05 09:00 (Thursday, America/Sao_Paulo)");
		expect(out.ok && out.summary).toContain("2026-11-05 14:00–15:00 | Reunião de produto @ Sala 2");
		expect(out.ok && out.summary).not.toContain("Amanhã cedo");
		expect(fake.cards).toHaveLength(1);
		expect(fake.cards[0]!.card).toMatchObject({ action: "listed", timeZone: "America/Sao_Paulo", events: [{ title: "Reunião de produto" }] });
	});
	it("dia livre também é resposta honesta (e o cartão diz que está livre)", async () => {
		const { fake, tool } = rig();
		const out = await tool("calendar_list").run({ date: "2026-11-07" }, ctx());
		expect(out.ok && out.summary).toContain("No events in this period.");
		expect(fake.cards[0]!.card.events).toEqual([]);
	});
	it("a agenda de outro dono não aparece (IDOR)", async () => {
		const { fake, tool } = rig();
		fake.seed("alice", MEETING);
		const bob = await tool("calendar_list").run({}, ctx({ ownerId: "bob" }));
		expect(bob.ok && bob.summary).toContain("No events");
		expect(JSON.stringify(fake.cards)).not.toContain("Reunião");
		expect(await tool("calendar_get").run({ eventId: "ev-1" }, ctx({ ownerId: "bob" }))).toMatchObject({ ok: false, error: expect.stringContaining("No event") });
	});
	it("período inválido falha com a dica; falha do Google vira ok:false com a mensagem real", async () => {
		const { fake, tool } = rig();
		expect(await tool("calendar_list").run({ date: "amanhã" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("YYYY-MM-DD") });
		expect(await tool("calendar_list").run({ from: "2026-11-01", to: "2026-12-30" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("limit is 31") });
		fake.fail = new CalendarNotConnectedError();
		expect(await tool("calendar_list").run({}, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("not connected") });
		expect(fake.cards).toEqual([]);
	});
	it("mais eventos que o limite: avisa para estreitar", async () => {
		const { fake, tool } = rig();
		for (let i = 0; i < 4; i += 1) fake.seed("o1", { title: `E${i}`, start: `2026-11-05T1${i}:00:00.000Z`, end: `2026-11-05T1${i}:30:00.000Z` });
		const out = await tool("calendar_list").run({ limit: 2 }, ctx());
		expect(out.ok && out.summary).toContain("more events in this period than 2");
	});
});

describe("calendar_create", () => {
	it("cria no fuso do dono, mostra o cartão e devolve recibo; sem convidado, ninguém é avisado", async () => {
		const { fake, tool } = rig();
		const out = await tool("calendar_create").run({ title: "Dentista", start: "2026-11-06T09:30", durationMinutes: 45, location: "Clínica Sorriso" }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { what: "Event created: Dentista", where: "Google Calendar", externalId: "ev-1" } });
		expect(out.ok && out.summary).toContain("2026-11-06 09:30–10:15 (America/Sao_Paulo)");
		expect(out.ok && out.summary).toContain("No overlap with other events.");
		expect(fake.events[0]).toMatchObject({ userId: "o1", start: "2026-11-06T12:30:00.000Z", end: "2026-11-06T13:15:00.000Z" });
		expect(fake.writes[0]).toMatchObject({ op: "create", notifyGuests: false });
		expect(fake.cards[0]!.card).toMatchObject({ action: "created", events: [{ title: "Dentista" }] });
		expect(fake.cards[0]!.card.notified).toBeUndefined();
	});
	it("INFORMA a sobreposição por horário (e marca no cartão), mas cria", async () => {
		const { fake, tool } = rig();
		fake.seed("o1", MEETING);
		const out = await tool("calendar_create").run({ title: "Almoço com Ana", start: "2026-11-05T14:30", durationMinutes: 60 }, ctx());
		expect(out.ok).toBe(true);
		expect(out.ok && out.summary).toContain("OVERLAPS 1 event");
		expect(out.ok && out.summary).toContain("Reunião de produto");
		expect(fake.events).toHaveLength(2);
		expect(fake.cards[0]!.card.events[0]).toMatchObject({ conflict: true });
	});
	it("encostar na ponta não é conflito; evento de dia inteiro não bloqueia nem é checado", async () => {
		const { fake, tool } = rig();
		fake.seed("o1", MEETING);
		expect((await tool("calendar_create").run({ title: "Depois", start: "2026-11-05T15:00" }, ctx())).ok && true).toBe(true);
		const allDay = await tool("calendar_create").run({ title: "Feriado", start: "2026-11-15" }, ctx());
		expect(allDay.ok && allDay.summary).toContain("All-day events do not block");
		expect(fake.cards.at(-1)!.card.events[0]).toMatchObject({ allDay: true });
	});
	it("conflito só com evento de outro dono não existe: a agenda de outra pessoa não conta (IDOR)", async () => {
		const { fake, tool } = rig();
		fake.seed("alice", MEETING);
		const out = await tool("calendar_create").run({ title: "Meu horário", start: "2026-11-05T14:00" }, ctx({ ownerId: "bob" }));
		expect(out.ok && out.summary).toContain("No overlap");
	});
	it("data no passado = o modelo errou o dia: recusa dizendo a data de hoje, e nada é criado", async () => {
		const { fake, tool } = rig();
		const out = await tool("calendar_create").run({ title: "Reunião", start: "2025-11-06T10:00" }, ctx());
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("in the past") });
		expect(!out.ok && out.error).toContain("Now: 2026-11-05 09:00");
		expect(fake.events).toEqual([]);
	});
	it("campo inválido falha com a dica; nada é criado", async () => {
		const { fake, tool } = rig();
		for (const args of [{ title: "x", start: "amanhã 10h" }, { title: "x", start: "2026-11-06T10:00", end: "2026-11-06T09:00" }, { title: "x", start: "2026-11-06T10:00", attendees: ["sem-arroba"] }, { start: "2026-11-06T10:00" }]) {
			expect((await tool("calendar_create").run(args, ctx())).ok, JSON.stringify(args)).toBe(false);
		}
		expect(fake.events).toEqual([]);
	});
	it("a checagem de conflito falhar não impede criar, mas a tool diz que não conferiu", async () => {
		const { fake, tool } = rig();
		fake.failList = new Error("Google respondeu 500");
		const out = await tool("calendar_create").run({ title: "x", start: "2026-11-06T10:00" }, ctx());
		expect(out.ok && out.summary).toContain("overlap check failed (Google respondeu 500)");
		expect(fake.events).toHaveLength(1);
	});
	it("com convidados: convite enviado, cartão diz isso, e o resumo lista quem recebeu", async () => {
		const { fake, tool } = rig();
		const out = await tool("calendar_create").run({ title: "Almoço", start: "2026-11-06T12:00", attendees: ["Ana@Example.com", "ana@example.com"] }, ctx());
		expect(out.ok && out.summary).toContain("Invitations were emailed to ana@example.com");
		expect(fake.writes[0]).toMatchObject({ notifyGuests: true });
		expect(fake.cards[0]!.card).toMatchObject({ notified: true, events: [{ attendeeCount: 1 }] });
	});
	it("a mesma chamada refeita (retomada) não cria o evento duas vezes: a chave da chamada vai à porta", async () => {
		const { fake, tool } = rig();
		const args = { title: "Uma vez só", start: "2026-11-06T10:00" };
		const a = await tool("calendar_create").run(args, ctx({ callId: "s2:call-9" }));
		const b = await tool("calendar_create").run(args, ctx({ callId: "s2:call-9" }));
		expect(fake.events).toHaveLength(1);
		expect(a.ok && b.ok).toBe(true);
		expect(fake.writes[0]).toMatchObject({ requestKey: "s2:call-9" });
	});
	it("falha do Google na criação é ok:false com a mensagem e sem cartão", async () => {
		const { fake, tool } = rig();
		fake.fail = new Error("HTTP 403: Falta permissão no conector: reconecte no Marketplace.");
		const out = await tool("calendar_create").run({ title: "x", start: "2026-11-06T10:00" }, ctx());
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("reconecte") });
		expect(fake.cards).toEqual([]);
	});
});

describe("calendar_update", () => {
	it("muda só o que veio, mantém a duração, NÃO avisa ninguém por padrão e diz isso", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("o1", { ...MEETING, attendees: ["ana@example.com"] });
		const out = await tool("calendar_update").run({ eventId: seeded.id, start: "2026-11-05T16:00" }, ctx());
		expect(out.ok && out.summary).toContain("Updated \"Reunião de produto\" (time): 2026-11-05 16:00–17:00");
		expect(out.ok && out.summary).toContain("Guests were not emailed.");
		expect(fake.events[0]).toMatchObject({ start: "2026-11-05T19:00:00.000Z", end: "2026-11-05T20:00:00.000Z", location: "Sala 2", attendees: ["ana@example.com"] });
		expect(fake.writes.at(-1)).toMatchObject({ op: "update", notifyGuests: false });
		expect(fake.cards[0]!.card).toMatchObject({ action: "updated" });
	});
	it("notifyGuests avisa os convidados; o próprio evento não conta como conflito, outro evento sim", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("o1", { ...MEETING, attendees: ["ana@example.com"] });
		fake.seed("o1", { title: "Call com cliente", start: "2026-11-05T19:00:00.000Z", end: "2026-11-05T20:00:00.000Z" });
		const same = await tool("calendar_update").run({ eventId: seeded.id, start: "2026-11-05T14:10" }, ctx({ callId: "c1" }));
		expect(same.ok && same.summary).toContain("No overlap");
		const moved = await tool("calendar_update").run({ eventId: seeded.id, start: "2026-11-05T16:00", notifyGuests: true }, ctx({ callId: "c2" }));
		expect(moved.ok && moved.summary).toContain("OVERLAPS 1 event");
		expect(moved.ok && moved.summary).toContain("Call com cliente");
		expect(moved.ok && moved.summary).toContain("Guests were emailed.");
		expect(fake.writes.at(-1)).toMatchObject({ notifyGuests: true });
		expect(fake.cards.at(-1)!.card).toMatchObject({ notified: true });
	});
	it("evento inexistente ou de outro dono: a mesma resposta (404), sem tocar em nada", async () => {
		const { fake, tool } = rig();
		const aliceEvent = fake.seed("alice", MEETING);
		const bob = await tool("calendar_update").run({ eventId: aliceEvent.id, title: "invadido" }, ctx({ ownerId: "bob" }));
		const none = await tool("calendar_update").run({ eventId: "nao-existe", title: "x" }, ctx({ ownerId: "bob" }));
		expect(bob).toMatchObject({ ok: false, error: expect.stringContaining("No event") });
		expect(none).toMatchObject({ ok: false, error: expect.stringContaining("No event") });
		expect(fake.events[0]!.title).toBe("Reunião de produto");
		expect(fake.writes).toEqual([]);
	});
	it("sem campo nenhum, horário passado e fim antes do início são recusados", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("o1", MEETING);
		expect(await tool("calendar_update").run({ eventId: seeded.id }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Nothing to change") });
		expect(await tool("calendar_update").run({ eventId: seeded.id, start: "2025-01-01T10:00" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("in the past") });
		expect(await tool("calendar_update").run({ eventId: seeded.id, end: "2026-11-05T13:00" }, ctx())).toMatchObject({ ok: false });
		expect(fake.writes).toEqual([]);
	});
});

describe("calendar_delete", () => {
	it("apaga, diz que os convidados não foram avisados e dá recibo", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("o1", { ...MEETING, attendees: ["ana@example.com", "bia@example.com"] });
		const out = await tool("calendar_delete").run({ eventId: seeded.id }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { what: "Event deleted: Reunião de produto", externalId: seeded.id } });
		expect(out.ok && out.summary).toContain("2 guests were not emailed");
		expect(fake.events).toEqual([]);
	});
	it("evento de outro dono ou inexistente: 404 igual, e nada é apagado (IDOR)", async () => {
		const { fake, tool } = rig();
		const aliceEvent = fake.seed("alice", MEETING);
		expect(await tool("calendar_delete").run({ eventId: aliceEvent.id }, ctx({ ownerId: "bob" }))).toMatchObject({ ok: false, error: expect.stringContaining("No event") });
		expect(await tool("calendar_delete").run({ eventId: "x" }, ctx({ ownerId: "bob" }))).toMatchObject({ ok: false });
		expect(fake.events).toHaveLength(1);
	});
});

describe("cartão de aprovação: qual evento", () => {
	const enriched = (tool: ReturnType<typeof rig>["tool"], name: string, args: Record<string, unknown>) => tool(name).enrichedRiskFactsFor(args, { ownerId: "o1" });

	it("apagar: o pedido leva título, horário, fuso e convidados do evento (lido antes de pedir)", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("o1", { ...MEETING, attendees: ["ana@example.com"] });
		const facts = await enriched(tool, "calendar_delete", { eventId: seeded.id });
		expect(facts).toMatchObject({ irreversible: true, event: { action: "delete", title: "Reunião de produto", start: MEETING.start, end: MEETING.end, timeZone: "America/Sao_Paulo", location: "Sala 2", guests: ["ana@example.com"], notifyGuests: false } });
		expect(JSON.stringify(facts)).not.toContain("Google Calendar:");
	});
	it("apagar evento de outro dono ou que não existe: o cartão sai sem o evento (nada vaza) e sem erro", async () => {
		const { fake, tool } = rig();
		const alice = fake.seed("alice", MEETING);
		expect((await enriched(tool, "calendar_delete", { eventId: alice.id }))?.event).toEqual({ action: "delete" });
	});
	it("alterar: mostra o evento como ficará; com notifyGuests os destinatários são os convidados do evento", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("o1", { ...MEETING, attendees: ["ana@example.com", "bia@example.com"] });
		const facts = await enriched(tool, "calendar_update", { eventId: seeded.id, title: "Reunião adiada", notifyGuests: true });
		expect(facts).toMatchObject({ event: { action: "update", title: "Reunião adiada", notifyGuests: true, guests: ["ana@example.com", "bia@example.com"] }, recipients: ["ana@example.com", "bia@example.com"], externalRecipients: ["ana@example.com", "bia@example.com"] });
		const silent = await enriched(tool, "calendar_update", { eventId: seeded.id, title: "Só renomear" });
		expect(silent?.recipients).toBeUndefined();
		expect(silent?.event?.notifyGuests).toBe(false);
	});
	it("criar: o horário do pedido vira instante no fuso do dono", async () => {
		const { tool } = rig();
		const facts = await enriched(tool, "calendar_create", { title: "Almoço", start: "2026-11-06T12:00", attendees: ["ana@example.com"] });
		expect(facts).toMatchObject({ event: { action: "create", title: "Almoço", start: "2026-11-06T15:00:00.000Z", end: "2026-11-06T16:00:00.000Z", timeZone: "America/Sao_Paulo", guests: ["ana@example.com"], notifyGuests: true }, recipients: ["ana@example.com"] });
	});
	it("falha ao ler a agenda não impede o cartão: sai com o fato síncrono", async () => {
		const { fake, tool } = rig();
		fake.ports.calendar.get = async () => {
			throw new Error("down");
		};
		expect(await enriched(tool, "calendar_delete", { eventId: "e1" })).toEqual({ irreversible: true, event: { action: "delete" } });
	});
	it("o executor pede a aprovação com o evento dentro do pedido", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("owner-1", MEETING);
		const out = await setup(chatPolicy).executor.executeCall({ callId: "c1", step: 1, tool: tool("calendar_delete"), args: { eventId: seeded.id } });
		expect(out).toMatchObject({ status: "pending_approval", request: { riskFacts: { event: { action: "delete", title: "Reunião de produto" } } } });
	});
});

describe("política: quem decide o quê", () => {
	const pol = (autonomy: "always_ask" | "balanced" | "autonomous") => ({ ...chatPolicy, autonomy });
	const args = { title: "Almoço", start: "2026-11-06T12:00" };

	it("no chat: criar sem convidado roda em autonomia total e pede aprovação nas outras; com convidado pede SEMPRE", async () => {
		const { tool } = rig();
		const run = async (policy: ReturnType<typeof pol>, a: Record<string, unknown>) => (await setup(policy).executor.executeCall({ callId: "c1", step: 1, tool: tool("calendar_create"), args: a })).status;
		expect(await run(pol("autonomous"), args)).toBe("ok");
		expect(await run(pol("balanced"), args)).toBe("pending_approval");
		expect(await run(pol("autonomous"), { ...args, attendees: ["ana@example.com"] })).toBe("pending_approval");
	});
	it("apagar pede o dono toda vez, até em autonomia total", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("owner-1", MEETING);
		const out = await setup(pol("autonomous")).executor.executeCall({ callId: "c2", step: 1, tool: tool("calendar_delete"), args: { eventId: seeded.id } });
		expect(out.status).toBe("pending_approval");
		expect(fake.events).toHaveLength(1);
	});
	it("depois de LER a agenda (texto de terceiros), criar evento pede aprovação mesmo em autonomia total", async () => {
		const { fake, tool } = rig();
		fake.seed("owner-1", MEETING);
		const { executor } = setup(pol("autonomous"));
		expect((await executor.executeCall({ callId: "l1", step: 1, tool: tool("calendar_list"), args: {} })).status).toBe("ok");
		expect((await executor.executeCall({ callId: "w1", step: 2, tool: tool("calendar_create"), args })).status).toBe("pending_approval");
	});
	it("SEM DONO (run de agenda): criar, alterar e apagar ficam ocultos (not_available), até em autonomia total e sem convidado", async () => {
		const { fake, tool } = rig();
		const seeded = fake.seed("owner-1", MEETING);
		const { executor } = setup(agendaRunPolicy({ autonomy: "autonomous", rules: [] }));
		const calls: Array<[string, Record<string, unknown>]> = [["calendar_create", args], ["calendar_update", { eventId: seeded.id, title: "x" }], ["calendar_delete", { eventId: seeded.id }]];
		for (const [name, a] of calls) {
			const out = await executor.executeCall({ callId: `a-${name}`, step: 1, tool: tool(name), args: a });
			expect(out.status, name).toBe("not_available");
		}
		expect(fake.events).toHaveLength(1);
		expect(fake.writes).toEqual([]);
		// Ler segue permitido.
		expect((await executor.executeCall({ callId: "a-list", step: 1, tool: tool("calendar_list"), args: {} })).status).toBe("ok");
	});
});

describe("economia: o 'Bom dia' não carrega o calendário", () => {
	const deps = () => ({ search: new FakeSearch(), files: new FakeFileStore(), calendar: new FakeCalendar().ports });

	it("só a linha do índice vai no prompt; nenhuma tool de calendário no 1º passo", async () => {
		const preset = setupPreset("full", deps());
		expect(preset.stableSystem).toContain("- calendar:");
		const h = kernelHarness([reply({ text: "Bom dia!" })], { capabilities: [...preset.registry.capabilities] });
		await h.run({ input: { stableSystem: preset.stableSystem, contextSections: [], history: [{ kind: "owner", text: "Bom dia" }] } });
		const names = h.llm.requests[0]?.tools?.map((t) => t.name) ?? [];
		expect(names.filter((n) => n.startsWith("calendar_"))).toEqual([]);
		expect(JSON.stringify(h.llm.requests[0]?.messages)).not.toContain("Calendar rules");
	});
	it("o pedido carrega a capacidade no passo 1 e o evento é criado nos seguintes", async () => {
		const calendar = new FakeCalendar();
		const preset = setupPreset("full", { ...deps(), calendar: calendar.ports });
		const h = kernelHarness(
			[
				reply({ calls: [call("a", "use_capability", { id: "calendar" })] }),
				reply({ calls: [call("b", "calendar_list", {})] }),
				reply({ calls: [call("c", "calendar_create", { title: "Dentista", start: "2026-11-06T09:30" })] }),
				reply({ text: "Marquei o dentista para amanhã às 9h30." }),
			],
			{ capabilities: [...preset.registry.capabilities] },
		);
		const result = await h.run({ policy: { ...chatPolicy, autonomy: "autonomous" }, input: { stableSystem: preset.stableSystem, contextSections: [], history: [{ kind: "owner", text: "Marca dentista amanhã 9h30" }] } });
		// Leu a agenda de terceiros antes (calendar_list): criar pede aprovação (taint), então o run estaciona e o evento NÃO nasce sem o dono.
		expect(result.status).toBe("parked");
		expect(calendar.events).toEqual([]);
		expect(h.llm.requests[1]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["calendar_list", "calendar_create", "calendar_update", "calendar_delete"]));
		expect(JSON.stringify(h.llm.requests[1]?.messages)).toContain("Calendar rules");
	});
});
