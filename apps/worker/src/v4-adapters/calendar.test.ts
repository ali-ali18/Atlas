/**
 * Google Agenda do v4 no worker (F7.1): token do cofre do DONO DO RUN, chamadas à API (fetch falso, sem rede), mapeamento,
 * convite só quando pedido, criação idempotente e cartão uma vez. Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/calendar.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CalendarNotConnectedError } from "@workspace/agent";
import { DEFAULT_PROACTIVE_SETTINGS, type ComputerUseEvent } from "@workspace/shared";
import { createV4Calendar, patchBody, toEventView, type V4CalendarDeps } from "./calendar.js";

type Req = { url: string; method: string; body?: Record<string, unknown>; auth?: string };

function rig(options: { respond?: (req: Req) => { status: number; body?: unknown } } = {}) {
	const requests: Req[] = [];
	const tokensFor: string[] = [];
	const persisted: Array<{ conversationId: string; type: string }> = [];
	const emitted: ComputerUseEvent[] = [];
	const deps: V4CalendarDeps = {
		// Só a dona A tem o Google Agenda conectado; B tem outro app.
		listConnected: async (userId) => (userId === "user-a" ? ([{ id: "conn-a", catalogId: "google_calendar", secretsEnc: "x" }] as never) : userId === "user-b" ? ([{ id: "conn-b", catalogId: "github" }] as never) : []),
		accessToken: async (record) => (tokensFor.push(record.id), `token-de-${record.id}`),
		fetchFn: async (url, init) => {
			const req: Req = { url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}), auth: (init?.headers as Record<string, string> | undefined)?.Authorization };
			requests.push(req);
			const out = options.respond?.(req) ?? { status: 200, body: {} };
			return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body ?? {}, text: async () => JSON.stringify(out.body ?? {}) };
		},
		loadSettings: (async () => ({ ...DEFAULT_PROACTIVE_SETTINGS, timezone: "America/Sao_Paulo" })) as never,
		persistCard: async (conversationId, event) => void persisted.push({ conversationId, type: event.type }),
	};
	const ports = createV4Calendar({ scope: { botId: "bot-1", conversationId: "conv-1", emit: (e) => void emitted.push(e), log: () => undefined }, deps });
	return { ports, calendar: ports.calendar, requests, tokensFor, persisted, emitted };
}

const GOOGLE_EVENT = { id: "g1", summary: "Reunião", start: { dateTime: "2026-11-10T14:00:00-03:00" }, end: { dateTime: "2026-11-10T15:00:00-03:00" }, location: "Sala 2", htmlLink: "https://www.google.com/calendar/event?eid=1", attendees: [{ email: "Dono@Example.com", self: true, responseStatus: "accepted" }, { email: "Ana@Example.com" }] };

test("mapeia o evento do Google: instante em UTC, dono fora dos convidados, resposta do dono, livre e cancelado", () => {
	assert.deepEqual(toEventView(GOOGLE_EVENT), { id: "g1", title: "Reunião", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, location: "Sala 2", attendees: ["ana@example.com"], link: "https://www.google.com/calendar/event?eid=1", selfResponse: "accepted" });
	assert.deepEqual(toEventView({ id: "g2", summary: "Feriado", start: { date: "2026-11-15" }, end: { date: "2026-11-16" }, transparency: "transparent", status: "cancelled", htmlLink: "javascript:x" }), { id: "g2", title: "Feriado", start: "2026-11-15", end: "2026-11-16", allDay: true, free: true, cancelled: true });
	assert.equal(toEventView({ id: "g3" }), null);
});

test("listar: usa o token do cofre do dono do run, pede um a mais para saber se cortou, e o cabeçalho leva só o Bearer", async () => {
	const { calendar, requests, tokensFor } = rig({ respond: () => ({ status: 200, body: { items: [GOOGLE_EVENT, { ...GOOGLE_EVENT, id: "g2" }, { ...GOOGLE_EVENT, id: "g3" }] } }) });
	const out = await calendar.list("user-a", { from: "2026-11-10T03:00:00.000Z", to: "2026-11-11T03:00:00.000Z" }, { limit: 2 });
	assert.equal(out.events.length, 2);
	assert.equal(out.truncated, true);
	assert.deepEqual(tokensFor, ["conn-a"]);
	const url = new URL(requests[0]!.url);
	assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
	assert.equal(url.searchParams.get("singleEvents"), "true");
	assert.equal(url.searchParams.get("maxResults"), "3");
	assert.equal(requests[0]!.auth, "Bearer token-de-conn-a");
});

test("IDOR: outro dono sem a conexão não consegue ler nada e nenhuma chamada sai; erro diz para conectar", async () => {
	const { calendar, requests, tokensFor } = rig();
	await assert.rejects(calendar.list("user-b", { from: "a", to: "b" }), (e: unknown) => e instanceof CalendarNotConnectedError && /not connected/.test((e as Error).message) && (e as CalendarNotConnectedError).code === "not_connected");
	await assert.rejects(calendar.get("user-c", "g1"), CalendarNotConnectedError);
	await assert.rejects(calendar.remove("user-b", "g1"), CalendarNotConnectedError);
	assert.deepEqual(requests, []);
	assert.deepEqual(tokensFor, []);
});

test("login expirado (UnauthorizedError do cofre/Google) vira 'reconectar', sem texto cru", async () => {
	const unauthorized = Object.assign(new Error("invalid_grant segredo sk-abcdefghijklmnopqrstuvwxyz0123456789"), { name: "UnauthorizedError" });
	const { calendar } = rig();
	const bad = createV4Calendar({ scope: { emit: () => undefined }, deps: { ...({} as V4CalendarDeps), listConnected: async () => [{ id: "c", catalogId: "google_calendar" } as never], accessToken: async () => { throw unauthorized; }, fetchFn: async () => { throw new Error("não deveria chamar"); }, loadSettings: (async () => DEFAULT_PROACTIVE_SETTINGS) as never, persistCard: async () => undefined } });
	await assert.rejects(bad.calendar.list("u", { from: "a", to: "b" }), (e: unknown) => e instanceof CalendarNotConnectedError && !/sk-/.test((e as Error).message) && /reconnect/.test((e as Error).message) && (e as CalendarNotConnectedError).code === "needs_connection");
	assert.ok(calendar);
});

test("erro do Google vira mensagem acionável e sem segredo (403 de escopo)", async () => {
	const { calendar } = rig({ respond: () => ({ status: 403, body: { error: { message: "Request had insufficient authentication scopes." } } }) });
	await assert.rejects(calendar.list("user-a", { from: "a", to: "b" }), /reconecte/);
});

test("get/update/remove: 404 e 410 são 'não existe' (null/false), outros erros sobem", async () => {
	const missing = rig({ respond: () => ({ status: 404, body: { error: { message: "Not Found" } } }) });
	assert.equal(await missing.calendar.get("user-a", "nope"), null);
	assert.equal(await missing.calendar.update("user-a", "nope", { draft: { title: "x", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, attendees: [] }, changed: ["title"] }, { notifyGuests: false }), null);
	assert.equal(await missing.calendar.remove("user-a", "nope"), false);
	const gone = rig({ respond: () => ({ status: 410, body: {} }) });
	assert.equal(await gone.calendar.remove("user-a", "old"), false);
	const boom = rig({ respond: () => ({ status: 500, body: { error: { message: "backend" } } }) });
	await assert.rejects(boom.calendar.get("user-a", "x"), /500/);
});

test("criar: sem convidado NÃO manda e-mail (sendUpdates=none), com convidado manda; id derivado da chave da chamada", async () => {
	const { calendar, requests } = rig({ respond: () => ({ status: 200, body: GOOGLE_EVENT }) });
	const draft = { title: "Reunião", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, attendees: [] as string[] };
	await calendar.create("user-a", draft, { notifyGuests: false, requestKey: "s2:call-1" });
	await calendar.create("user-a", { ...draft, attendees: ["ana@example.com"] }, { notifyGuests: true, requestKey: "s2:call-1" });
	assert.equal(new URL(requests[0]!.url).searchParams.get("sendUpdates"), "none");
	assert.equal(new URL(requests[1]!.url).searchParams.get("sendUpdates"), "all");
	assert.equal(requests[0]!.method, "POST");
	assert.match(String(requests[0]!.body?.id), /^[0-9a-f]{64}$/);
	assert.equal(requests[0]!.body?.id, requests[1]!.body?.id);
	assert.deepEqual(requests[1]!.body?.attendees, [{ email: "ana@example.com" }]);
	assert.deepEqual(requests[0]!.body?.start, { dateTime: "2026-11-10T17:00:00.000Z" });
});

test("criar de novo com a mesma chave (409) devolve o evento que já existe, em vez de duplicar ou falhar", async () => {
	const { calendar, requests } = rig({ respond: (req) => (req.method === "POST" ? { status: 409, body: { error: { message: "The requested identifier already exists." } } } : { status: 200, body: GOOGLE_EVENT }) });
	const out = await calendar.create("user-a", { title: "Reunião", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, attendees: [] }, { notifyGuests: false, requestKey: "s2:call-1" });
	assert.equal(out.id, "g1");
	assert.equal(requests.at(-1)!.method, "GET");
});

test("alterar manda só o que mudou; local/descrição vazios apagam; apagar nunca avisa convidado", async () => {
	const draft = { title: "Novo título", start: "2026-11-10T19:00:00.000Z", end: "2026-11-10T20:00:00.000Z", allDay: false, attendees: [] as string[] };
	assert.deepEqual(patchBody({ draft, changed: ["title"] }), { summary: "Novo título" });
	assert.deepEqual(patchBody({ draft, changed: ["time", "location", "description", "attendees"] }), { start: { dateTime: draft.start }, end: { dateTime: draft.end }, location: null, description: null, attendees: [] });
	const { calendar, requests } = rig({ respond: () => ({ status: 200, body: GOOGLE_EVENT }) });
	await calendar.update("user-a", "g1", { draft, changed: ["title"] }, { notifyGuests: false });
	assert.equal(requests[0]!.method, "PATCH");
	assert.equal(new URL(requests[0]!.url).searchParams.get("sendUpdates"), "none");
	assert.equal(await calendar.remove("user-a", "g1"), true);
	assert.equal(requests[1]!.method, "DELETE");
	assert.equal(new URL(requests[1]!.url).searchParams.get("sendUpdates"), "none");
});

test("fuso do dono vem das configurações da agenda do bot do run", async () => {
	assert.equal(await rig().calendar.timeZone("user-a"), "America/Sao_Paulo");
});

test("cartão: grava na conversa e emite UMA vez por identidade; falha ao gravar não derruba o run", async () => {
	const r = rig();
	const card = { cardId: "calendar:run-1:created:g1", action: "created" as const, timeZone: "America/Sao_Paulo", events: [{ id: "g1", title: "Reunião", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false }] };
	await r.ports.cards!.show("user-a", "run-1", card);
	await r.ports.cards!.show("user-a", "run-1", card);
	assert.deepEqual(r.persisted, [{ conversationId: "conv-1", type: "calendar" }]);
	assert.equal(r.emitted.length, 1);
	assert.deepEqual(r.emitted[0], { type: "calendar", ...card, runId: "run-1" });
});
