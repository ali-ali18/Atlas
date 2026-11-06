// Capacidade `agenda` (F4.2): a proatividade do agente. O modelo atravessa turnos de forma EXPLÍCITA: `remind_me` (lembrete
// ou "eu volto"), `watch` (de X em X tempo, até uma condição) e `on_event` (quando chegar o e-mail tal, faço Y), mais listar
// e pausar/cancelar (o que a UI faz o bot faz pelo chat). A criação é SILENCIOSA (sem cartão; decisão do dono), mas o
// resultado é honesto: a tool diz o que foi (ou não foi) agendado.
//
// `agenda-run` é outra capacidade, só dos runs de agenda (acordados pelo worker): `agenda_result` fecha o run com
// `no_change | update | done`. Ela não existe no chat, então o modelo nunca "fecha" um item por engano e um run de agenda
// nunca cria itens novos em cadeia.
//
// Nenhuma decisão aqui lê texto livre: os freios e a normalização são de `planAgendaItem` (shared), que usa só campos
// declarados (intervalo, vigência, filtro de evento) e datas.
import {
	AGENDA_MAX_ACTIVE_PER_OWNER,
	AGENDA_MEMO_MAX_CHARS,
	AGENDA_MESSAGE_MAX_CHARS,
	AGENDA_MIN_INTERVAL_MINUTES,
	AGENDA_NOTE_MAX_CHARS,
	AGENDA_OUTCOMES,
	AGENDA_EVENT_SOURCES,
	planAgendaItem,
	type AgendaRequest,
} from "@workspace/shared";
import { z } from "zod";
import type { Agenda, AgendaItemView } from "../../ports/agenda.js";
import { defineTool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";

const whenField = z.string().trim().min(1).max(120);
const noteField = z.string().trim().min(1).max(AGENDA_NOTE_MAX_CHARS);
const askedShort = z.boolean().optional().describe("true ONLY when the owner explicitly asked for an interval shorter than 2 hours. Never infer it.");

/** "2026-11-05 10:00" no fuso do dono (formato estável, sem padrão sobre texto). */
function localStamp(iso: string, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function describeItem(item: AgendaItemView, timeZone: string): string {
	const parts = [`id ${item.id}`, item.kind, item.status];
	if (item.kind === "intent") {
		const f = item.eventFilter;
		parts.push(`on ${f?.source ?? "event"}${f?.from ? ` from ${f.from}` : ""}${f?.subjectContains ? ` subject has "${f.subjectContains}"` : ""}${f?.hasAttachment !== undefined ? ` attachment ${f.hasAttachment ? "yes" : "no"}` : ""}`);
		if (item.untilAt) parts.push(`valid until ${localStamp(item.untilAt, timeZone)}`);
	} else {
		if (item.status === "pending") parts.push(`next ${localStamp(item.nextRunAt, timeZone)}`);
		if (item.everyMinutes) parts.push(`every ${item.everyMinutes} min`);
		if (item.untilAt) parts.push(`until ${localStamp(item.untilAt, timeZone)}`);
	}
	if (item.maxRuns !== null) parts.push(`${item.runCount}/${item.maxRuns} runs`);
	else if (item.runCount > 0) parts.push(`${item.runCount} runs`);
	if (item.endReason && item.status !== "pending" && item.status !== "paused") parts.push(`ended: ${item.endReason}`);
	return `- ${parts.join(" | ")} | ${item.note}`;
}

export function createAgendaCapability(agenda: Agenda) {
	async function schedule(request: AgendaRequest, ctx: { ownerId: string; runId: string; now: Date; untrustedRead: boolean }, noun: string) {
		const settings = await agenda.settings(ctx.ownerId);
		const planned = planAgendaItem({ request, now: ctx.now, settings });
		if (!planned.ok) return { ok: false as const, error: planned.error, hint: "Fix the field named in the error and call again." };
		const { plan } = planned;
		const created = await agenda.create(ctx.ownerId, plan, { sourceRunId: ctx.runId, untrustedRead: ctx.untrustedRead });
		if (!created.ok) return { ok: false as const, error: created.error, hint: "Use agenda_list to see the active items, then agenda_change to cancel one." };
		const { item } = created;
		const tz = settings.timezone;
		const when = item.kind === "intent" ? `valid until ${localStamp(item.untilAt ?? item.nextRunAt, tz)}` : `first run ${localStamp(item.nextRunAt, tz)} (${tz})`;
		const notes = plan.adjustments.length > 0 ? ` Adjusted: ${plan.adjustments.join("; ")}.` : "";
		const headline = created.duplicate ? `Already scheduled (nothing new created): ${noun} ${item.id}, ${when}.` : `Scheduled ${noun} ${item.id}: ${when}.`;
		return {
			ok: true as const,
			summary: `${headline}${notes} It is silent: the owner is told only when there is news.`,
			receipt: { what: created.duplicate ? `Agenda already had: ${noun}` : `Agenda: ${noun} scheduled`, where: "Agenda", externalId: item.id },
		};
	}

	const remindMe = defineTool({
		name: "remind_me",
		description:
			"Schedule a reminder or a 'come back to this later' for yourself: at the time, you wake up and tell the owner. Use it when the owner asks to be reminded, or when you decide a follow-up is worth doing. " +
			"Creating is silent (no confirmation card): if the owner asked, confirm in one short plain sentence with the day and time; if you inferred it, do not announce it. " +
			"Do not use it to keep checking something until a condition is met (use watch) or to react to an incoming email (use on_event). Write the note for your future self, in the owner's language.",
		inputSchema: z.object({
			note: noteField.describe("What to do or say when it wakes. One or two sentences, self-contained."),
			when: whenField.describe('First time: ISO 8601 like 2026-11-05T10:00 (no zone = the owner\'s zone) or text like "tomorrow 10:00".'),
			everyMinutes: z.number().optional().describe(`Repeat every N minutes (at least ${AGENDA_MIN_INTERVAL_MINUTES}). Leave out for a one-off reminder.`),
			until: whenField.optional().describe("When a repeating reminder ends. Only with everyMinutes."),
			maxRuns: z.number().optional().describe("Most times it wakes. Only with everyMinutes."),
			ownerAskedShortInterval: askedShort,
		}),
		effect: "write_internal",
		riskFacts: () => ({ target: "Agenda" }),
		execute: (args, ctx) => schedule({ kind: "remind", ...args }, { ownerId: ctx.ownerId, runId: ctx.runId, now: ctx.ports.clock.now(), untrustedRead: ctx.untrustedReadInRun === true }, "reminder"),
	});

	const watch = defineTool({
		name: "watch",
		description:
			"Check something again and again, quietly, until a condition is met or time runs out (a price drops, a delivery arrives, a page changes). Each time it wakes you do the check and report with agenda_result; the owner hears from you only when there is news. " +
			"Use it when the owner asks to be told when something happens, or when you decide to follow something up. Creating is silent. The wait grows by itself while nothing changes. " +
			`Interval is at least ${AGENDA_MIN_INTERVAL_MINUTES} minutes unless the owner explicitly asked for less. Always give an end (until or maxRuns); without one it stops after 14 days. ` +
			"Do not use it for a single reminder (remind_me) or for an incoming email (on_event). In the note, say what to check, what counts as news, and when to finish.",
		inputSchema: z.object({
			note: noteField.describe("What to check, what counts as news, and when it is finished. Self-contained."),
			everyMinutes: z.number().describe(`Minutes between checks (at least ${AGENDA_MIN_INTERVAL_MINUTES}).`),
			when: whenField.optional().describe("First check. Default: one interval from now."),
			until: whenField.optional().describe("When to stop watching."),
			maxRuns: z.number().optional().describe("Most checks."),
			ownerAskedShortInterval: askedShort,
		}),
		effect: "write_internal",
		riskFacts: () => ({ target: "Agenda" }),
		execute: (args, ctx) => schedule({ kind: "watch", ...args }, { ownerId: ctx.ownerId, runId: ctx.runId, now: ctx.ports.clock.now(), untrustedRead: ctx.untrustedReadInRun === true }, "watch"),
	});

	const onEvent = defineTool({
		name: "on_event",
		description:
			"Do something when a matching event arrives, instead of on a clock (for example when an email from a given sender comes in). The match uses the fields you set, exactly, and at least one is required. " +
			"Creating is silent. When it wakes you handle that event and report with agenda_result. Use it for 'when X arrives, do Y'; do not use it for time-based reminders (remind_me) or repeated checks (watch).",
		inputSchema: z.object({
			note: noteField.describe("What to do when a matching event arrives. Self-contained."),
			source: z.enum(AGENDA_EVENT_SOURCES),
			from: z.string().trim().min(1).max(200).optional().describe('Sender: a full address, or a domain like "bank.com" (subdomains match).'),
			subjectContains: z.string().trim().min(1).max(200).optional().describe("A piece of the subject, matched literally, ignoring case. Not a pattern."),
			hasAttachment: z.boolean().optional(),
			until: whenField.optional().describe("How long it stays active. Default 30 days."),
			maxRuns: z.number().optional().describe("Most times it wakes."),
		}),
		effect: "write_internal",
		riskFacts: () => ({ target: "Agenda" }),
		execute: ({ note, source, from, subjectContains, hasAttachment, until, maxRuns }, ctx) =>
			schedule(
				{ kind: "intent", note, eventFilter: { source, ...(from !== undefined && { from }), ...(subjectContains !== undefined && { subjectContains }), ...(hasAttachment !== undefined && { hasAttachment }) }, ...(until !== undefined && { until }), ...(maxRuns !== undefined && { maxRuns }) },
				{ ownerId: ctx.ownerId, runId: ctx.runId, now: ctx.ports.clock.now(), untrustedRead: ctx.untrustedReadInRun === true },
				"event trigger",
			),
	});

	const agendaList = defineTool({
		name: "agenda_list",
		description: "List the owner's agenda items (reminders, watches and event triggers) with their id, next run and state. Use it when the owner asks what is scheduled, before changing or cancelling an item, or when the limit is reached.",
		inputSchema: z.object({ includeEnded: z.boolean().optional().describe("Also list finished and cancelled items.") }),
		effect: "read",
		async execute({ includeEnded }, ctx) {
			const [items, settings] = await Promise.all([agenda.list(ctx.ownerId, { includeEnded: includeEnded === true }), agenda.settings(ctx.ownerId)]);
			if (items.length === 0) return { ok: true, summary: includeEnded ? "The agenda is empty." : "No active agenda items." };
			return { ok: true, summary: `${items.length} item${items.length === 1 ? "" : "s"} (times in ${settings.timezone}; at most ${AGENDA_MAX_ACTIVE_PER_OWNER} active):\n${items.map((i) => describeItem(i, settings.timezone)).join("\n")}` };
		},
	});

	const agendaChange = defineTool({
		name: "agenda_change",
		description: "Pause, resume or cancel one agenda item by id (from agenda_list). Use it when the owner wants to stop, pause or bring back a reminder, watch or event trigger. Resuming also clears the 'ignored' count. Cancel is final for that item.",
		inputSchema: z.object({ id: z.string().trim().min(1).max(100), action: z.enum(["pause", "resume", "cancel"]) }),
		effect: "write_internal",
		riskFacts: ({ action }) => ({ target: `Agenda (${action})` }),
		async execute({ id, action }, ctx) {
			const item = await agenda.change(ctx.ownerId, id, action);
			// Item de outro dono, inexistente ou em estado que não aceita a ação: a mesma resposta (não revela que existe).
			if (!item) return { ok: false, error: `No agenda item "${id}" can be ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`, hint: "Call agenda_list for the ids and states." };
			const verb = action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Cancelled";
			return { ok: true, summary: `${verb} ${item.kind} ${item.id}.`, receipt: { what: `Agenda: ${item.kind} ${verb.toLowerCase()}`, where: "Agenda", externalId: item.id } };
		},
	});

	return defineCapability({
		id: "agenda",
		title: "Agenda",
		summary: "Reminders, quiet watches and event triggers that wake you later.",
		tools: [remindMe, watch, onEvent, agendaList, agendaChange],
		instructions:
			"Agenda rules: creating is silent (no card). Mention a new item only if the owner asked for it, in one plain sentence with the day and time; never name tools or fields. " +
			"Check agenda_list before adding something that may already exist. The server caps active items and stops a watch after two unread notices in a row, so do not work around it. " +
			"Say what you did or could not do in the owner's words, and offer an alternative when a limit blocks you.",
	});
}

/**
 * Só nos runs de agenda (worker de wake): fecha o run com o resultado declarado. Núcleo desse run (já carregada).
 * O `runId` do contexto liga o resultado ao item que acordou; outro dono ou run sem item = erro real.
 */
export function createAgendaRunCapability(agenda: Agenda) {
	const agendaResult = defineTool({
		name: "agenda_result",
		description:
			"Close this agenda run with its result. Call it exactly once, as your last step. no_change = nothing new (the owner hears nothing; do not send a message). update = there is news; message is what the owner will read. done = the job is finished and the item should end (message optional). " +
			"memo is what to remember for the next run (last price, last id seen); it is not shown to the owner. pending lists what needs the owner (an approval, a missing detail): finish what you can and put it there instead of asking.",
		inputSchema: z.object({
			outcome: z.enum(AGENDA_OUTCOMES),
			message: z.string().trim().min(1).max(AGENDA_MESSAGE_MAX_CHARS).optional().describe("What the owner reads, in their language. Required for update; not allowed for no_change."),
			memo: z.string().trim().min(1).max(AGENDA_MEMO_MAX_CHARS).optional(),
			pending: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
		}),
		// Fecha o run do próprio bot: o texto ao dono só sai pelo processador, que o repassa pela conversa do dono.
		effect: "write_internal",
		endsRun: true,
		riskFacts: () => ({ target: "Agenda" }),
		async execute({ outcome, message, memo, pending }, ctx) {
			if (outcome === "no_change" && message !== undefined) return { ok: false, error: "no_change must not carry a message: the owner is not told when nothing changed.", hint: "If there is news, use update with a message; otherwise call no_change without message." };
			if (outcome === "update" && message === undefined) return { ok: false, error: "update needs a message: it is what the owner will read.", hint: "Write the news in the owner's language, or use no_change if there is none." };
			if (outcome === "no_change" && pending !== undefined && pending.length > 0) return { ok: false, error: "pending needs the owner, so the owner must hear about it: use update with a message that mentions it.", hint: "Use outcome update and put it in the message, or drop pending." };
			const reported = await agenda.reportResult(ctx.ownerId, ctx.runId, { outcome, ...(message !== undefined && { message }), ...(memo !== undefined && { memo }), ...(pending !== undefined && { pending }) }, { untrustedRead: ctx.untrustedReadInRun === true });
			if (!reported.ok) return { ok: false, error: reported.error, hint: "This tool only works in a run woken by the agenda." };
			const said = outcome === "no_change" ? "nothing will be posted" : message ? "the message will be delivered" : "the item ends without a message";
			return { ok: true, summary: `Result recorded (${outcome}); ${said}. The run ends now.`, receipt: { what: `Agenda result: ${outcome}`, where: "Agenda" } };
		},
	});

	return defineCapability({
		id: "agenda-run",
		title: "Resultado da agenda",
		summary: "Report the result of this agenda run.",
		core: true,
		tools: [agendaResult],
	});
}
