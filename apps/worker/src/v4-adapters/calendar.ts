// Porta `Calendar` do v4 no worker (F7.1) sobre o Google Agenda do dono: o token vem do cofre da conexão `google_calendar`
// DO DONO DO RUN (renovado por `getFreshAccessToken`), e a chamada usa `googleFetch/googleJson` de `@workspace/google`.
// Escopo: `listConnected(userId)` filtra por dono no db; nunca se usa a conexão de outro dono nem um id vindo do modelo.
// Segredo: o access token nunca é logado nem volta ao modelo; mensagem de erro passa por `sanitizeErrorMessage`.
// Escopo OAuth do catálogo: `calendar.readonly` + `calendar.events`; `events` cobre inserir, alterar e apagar evento.
import { createHash } from "node:crypto";
import { CalendarNotConnectedError, type Calendar, type CalendarCards, type CalendarEventPatch, type CalendarPorts } from "@workspace/agent";
import { GoogleApiError, getFreshAccessToken, googleFetch, googleJson, mapGoogleApiError, mcpOAuthClientFor, persistTo, type GoogleApiContext, type GoogleFetchFn } from "@workspace/google";
import { openSecrets } from "@workspace/db/vault-crypto";
import { listConnectedMcpConnections, loadAgendaSettings, persistConversationCardFromEvent } from "@workspace/db";
import { sanitizeErrorMessage, type CalendarEventDraft, type CalendarEventView, type ComputerUseEvent } from "@workspace/shared";

type Connected = Awaited<ReturnType<typeof listConnectedMcpConnections>>[number];

export type V4CalendarDeps = {
	listConnected: (userId: string) => Promise<Connected[]>;
	/** Token de acesso pronto da conexão (renova pelo refresh_token). Lança se o login expirou. */
	accessToken: (record: Connected) => Promise<string>;
	fetchFn: GoogleFetchFn;
	loadSettings: typeof loadAgendaSettings;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4CalendarDeps: V4CalendarDeps = {
	listConnected: listConnectedMcpConnections,
	accessToken: async (record) => {
		const readiness = mcpOAuthClientFor(record);
		if (!readiness.ready) throw new CalendarNotConnectedError();
		return getFreshAccessToken({ secrets: openSecrets(record.secretsEnc), client: readiness.client, persist: persistTo(record.id) });
	},
	fetchFn: (input, init) => fetch(input, init),
	loadSettings: loadAgendaSettings,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4CalendarScope = {
	botId?: string | null;
	conversationId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CATALOG_ID = "google_calendar";

type GoogleTime = { date?: string; dateTime?: string };
type GoogleEvent = {
	id: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	transparency?: string;
	start?: GoogleTime;
	end?: GoogleTime;
	attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
};

export function toEventView(event: GoogleEvent): CalendarEventView | null {
	const allDay = Boolean(event.start?.date && !event.start.dateTime);
	const start = allDay ? event.start?.date : event.start?.dateTime && new Date(event.start.dateTime).toISOString();
	const end = allDay ? event.end?.date : event.end?.dateTime && new Date(event.end.dateTime).toISOString();
	if (!event.id || !start || !end) return null;
	const emails = (event.attendees ?? []).flatMap((a) => (a.email && !a.self ? [a.email.toLowerCase()] : []));
	const self = event.attendees?.find((a) => a.self)?.responseStatus;
	return {
		id: event.id,
		title: event.summary ?? "",
		start,
		end,
		allDay,
		...(event.location && { location: event.location }),
		...(event.description && { description: event.description }),
		...(emails.length > 0 && { attendees: emails }),
		...(event.htmlLink && /^https:\/\//.test(event.htmlLink) && { link: event.htmlLink }),
		...(event.transparency === "transparent" && { free: true }),
		...(event.status === "cancelled" && { cancelled: true }),
		...(self === "accepted" || self === "declined" || self === "tentative" || self === "needsAction" ? { selfResponse: self } : {}),
	};
}

const toGoogleTime = (value: string, allDay: boolean, timeZone?: string): Record<string, string> => (allDay ? { date: value } : { dateTime: value, ...(timeZone && { timeZone }) });

/** Corpo do PATCH: só o que mudou (`location`/`description` vazios apagam). */
export function patchBody(patch: CalendarEventPatch): Record<string, unknown> {
	const { draft, changed } = patch;
	const body: Record<string, unknown> = {};
	if (changed.includes("title")) body.summary = draft.title;
	if (changed.includes("time")) {
		body.start = toGoogleTime(draft.start, draft.allDay);
		body.end = toGoogleTime(draft.end, draft.allDay);
	}
	if (changed.includes("location")) body.location = draft.location ?? null;
	if (changed.includes("description")) body.description = draft.description ?? null;
	if (changed.includes("attendees")) body.attendees = draft.attendees.map((email) => ({ email }));
	return body;
}

const createBody = (draft: CalendarEventDraft): Record<string, unknown> => ({
	summary: draft.title,
	start: toGoogleTime(draft.start, draft.allDay),
	end: toGoogleTime(draft.end, draft.allDay),
	...(draft.location && { location: draft.location }),
	...(draft.description && { description: draft.description }),
	...(draft.attendees.length > 0 && { attendees: draft.attendees.map((email) => ({ email })) }),
});

/** Id do evento derivado da chave da chamada (hex ⊂ base32hex do Google): o mesmo pedido refeito não cria outro. */
const eventIdFor = (requestKey: string): string => createHash("sha256").update(`atlas-calendar:${requestKey}`).digest("hex");

export function createV4Calendar(input: { scope: V4CalendarScope; deps?: V4CalendarDeps }): CalendarPorts {
	const deps = input.deps ?? realV4CalendarDeps;
	const { scope } = input;

	async function context(userId: string): Promise<GoogleApiContext> {
		const record = (await deps.listConnected(userId)).find((c) => c.catalogId === CATALOG_ID);
		if (!record) throw new CalendarNotConnectedError(undefined, "never");
		return { getAccessToken: () => deps.accessToken(record), fetchFn: deps.fetchFn };
	}

	/** Erro do Google/OAuth em mensagem real, sem segredo e sem texto cru de terceiro além do necessário. */
	function fail(error: unknown): never {
		if (error instanceof CalendarNotConnectedError) throw error;
		if (error instanceof Error && (error.name === "UnauthorizedError" || error.constructor.name === "UnauthorizedError")) throw new CalendarNotConnectedError("Google Calendar login expired. Tell the owner plainly to reconnect it in the connected apps.");
		if (error instanceof GoogleApiError) throw new Error(sanitizeErrorMessage(mapGoogleApiError(error.status, error.message, "calendar")));
		throw new Error(sanitizeErrorMessage(error));
	}
	const run = async <T>(userId: string, work: (ctx: GoogleApiContext) => Promise<T>): Promise<T> => {
		try {
			return await work(await context(userId));
		} catch (error) {
			return fail(error);
		}
	};
	const notFound = (error: unknown): boolean => error instanceof GoogleApiError && (error.status === 404 || error.status === 410);
	const url = (path: string, params: Record<string, string>) => {
		const u = new URL(path ? `${API}/${encodeURIComponent(path)}` : API);
		for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
		return u.toString();
	};
	const json = { "Content-Type": "application/json" };

	const calendar: Calendar = {
		async timeZone(userId) {
			return (await deps.loadSettings(userId, scope.botId ?? "")).timezone;
		},
		list: (userId, range, options) =>
			run(userId, async (ctx) => {
				const limit = options?.limit ?? 25;
				const data = await googleJson<{ items?: GoogleEvent[] }>(ctx, url("", { timeMin: range.from, timeMax: range.to, singleEvents: "true", orderBy: "startTime", maxResults: String(limit + 1) }), options?.signal ? { signal: options.signal } : undefined);
				const events = (data.items ?? []).flatMap((e) => toEventView(e) ?? []);
				return { events: events.slice(0, limit), truncated: events.length > limit };
			}),
		get: (userId, eventId, signal) =>
			run(userId, async (ctx) => {
				try {
					return toEventView(await googleJson<GoogleEvent>(ctx, url(eventId, {}), signal ? { signal } : undefined));
				} catch (error) {
					if (notFound(error)) return null;
					throw error;
				}
			}),
		create: (userId, draft, options) =>
			run(userId, async (ctx) => {
				const id = options.requestKey ? eventIdFor(options.requestKey) : undefined;
				try {
					const created = await googleJson<GoogleEvent>(ctx, url("", { sendUpdates: options.notifyGuests ? "all" : "none" }), { method: "POST", headers: json, body: JSON.stringify({ ...createBody(draft), ...(id && { id }) }), ...(options.signal && { signal: options.signal }) });
					const view = toEventView(created);
					if (!view) throw new Error("Google Calendar returned an event without a time.");
					return view;
				} catch (error) {
					// 409: a mesma chamada já criou este evento (retomada). Devolve o que existe em vez de duplicar.
					if (id && error instanceof GoogleApiError && error.status === 409) {
						const existing = toEventView(await googleJson<GoogleEvent>(ctx, url(id, {})));
						if (existing) return existing;
					}
					throw error;
				}
			}),
		update: (userId, eventId, patch, options) =>
			run(userId, async (ctx) => {
				try {
					const updated = await googleJson<GoogleEvent>(ctx, url(eventId, { sendUpdates: options.notifyGuests ? "all" : "none" }), { method: "PATCH", headers: json, body: JSON.stringify(patchBody(patch)), ...(options.signal && { signal: options.signal }) });
					return toEventView(updated);
				} catch (error) {
					if (notFound(error)) return null;
					throw error;
				}
			}),
		remove: (userId, eventId, signal) =>
			run(userId, async (ctx) => {
				try {
					await googleFetch(ctx, url(eventId, { sendUpdates: "none" }), { method: "DELETE", ...(signal && { signal }) });
					return true;
				} catch (error) {
					if (notFound(error)) return false;
					throw error;
				}
			}),
	};

	// Cartão gravado e emitido uma vez por identidade dentro do run (a retomada cai no dedupe do db e do merge da conversa).
	const shown = new Set<string>();
	const cards: CalendarCards = {
		async show(_userId, runId, card) {
			if (shown.has(card.cardId)) return;
			shown.add(card.cardId);
			const event: ComputerUseEvent = { type: "calendar", ...card, runId };
			if (scope.conversationId) {
				await deps.persistCard(scope.conversationId, event).catch((error: unknown) => {
					(scope.log ?? console.warn)(`[engine-v4] cartão "calendar" não gravado na conversa: ${sanitizeErrorMessage(error).slice(0, 200)}`);
				});
			}
			await scope.emit(event);
		},
	};
	return { calendar, cards };
}
