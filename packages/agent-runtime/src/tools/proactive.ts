import type { ChatTool } from "@workspace/llm";
import {
	INTERVAL_EVERY_MINUTES_MAX,
	INTERVAL_EVERY_MINUTES_MIN,
	PROACTIVE_MAX_ACTIONS_PER_REFLECTION,
	findDuplicateRoutine,
	FOLLOWUP_INFERRED_MAX_OPEN,
	FOLLOWUP_STAGES_MAX,
	formatFollowupDue,
	isCronFive,
	isInQuietHours,
	nextAllowedTime,
	normalizeNewStages,
	parseRoutineProposalSpec,
	planFollowupReschedule,
	resolveFollowupWhen,
	suggestReminderStages,
	type PersistedRoutineProposalCard,
	type ProactiveGate,
	type ProactiveSettings,
	type RoutineProposalSpec,
	type RoutineRecord,
} from "@workspace/shared";
import {
	FollowupError,
	appendConversationMessage,
	appendRoutineProposalCard,
	cancelFollowup,
	createFollowup,
	createRoutineFromProposal,
	findRecentProposalByName,
	getBotConversationId,
	listFollowups,
	listRoutines,
	recordProactiveEvent,
	rescheduleOwnedFollowup,
	reserveProactiveMessage,
} from "@workspace/db";
import { clipForJev, decideWithJev, jevYes, type JevRuntime } from "../jev/decide.js";

/**
 * Modo proativo (bot principal): lembretes sem cron, ideias de rotina e a única forma de
 * o bot falar sozinho (`notify_user`, só na reflexão diária; em rotina "só importante" e no chat
 * longo o mesmo nome vira push avulso, ver `executeUserPush`). Silêncio, teto diário e Jev
 * valem aqui, no servidor, não no que o modelo resolver fazer.
 */

export const SCHEDULE_FOLLOWUP_TOOL_NAME = "schedule_followup";
export const LIST_FOLLOWUPS_TOOL_NAME = "list_followups";
export const CANCEL_FOLLOWUP_TOOL_NAME = "cancel_followup";
export const RESCHEDULE_FOLLOWUP_TOOL_NAME = "reschedule_followup";
export const SUGGEST_ROUTINE_TOOL_NAME = "suggest_routine";
export const NOTIFY_USER_TOOL_NAME = "notify_user";

/** Jev: abaixo disto a mensagem proativa não sai. */
export const PROACTIVE_JEV_THRESHOLD = 0.6;
const NOTIFY_MAX_CHARS = 700;

export const SCHEDULE_FOLLOWUP_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SCHEDULE_FOLLOWUP_TOOL_NAME,
		description:
			"Schedule a one-off follow-up for the user: at the given time you wake up in this chat and either remind them (kind=reminder) or do the task in `note` and report (kind=check). No cron needed. Use it when the user mentions a deadline, commitment or something to remember (\"vence dia 13\", \"me lembra\", \"semana que vem tenho prova\") or asks to be reminded or to have something checked later. Do not use it for a recurring task (that is a routine) or for something to do right now. DEADLINES: never schedule a single reminder close to the due date. Call list_followups first: if one already covers this subject, do not create another (use reschedule_followup). Otherwise create ONE follow-up per subject/deadline with staged notices in `stages` (up to 4 dates, one card for the user): an early one soon (next day, or within 2-3 days) to plan the work; for far deadlines intermediate ones roughly every 1-2 weeks or at known milestones; and one 2-3 days before the deadline (plus the day before when it is important). Mind the daily limit. Instead of writing the dates yourself you can pass `deadline` (the due date) and omit `when`/`stages`: the server picks the staged dates. A plain one-off reminder just uses `when`. `when` is an ISO 8601 datetime or Brazilian Portuguese like \"amanhã 9h\", \"daqui a 2 horas\", \"segunda às 8h\", \"dia 13 às 18h\", \"semana que vem\"; it is read in the user's timezone and must be in the future (a date without time means 09:00). Write `note` so it makes sense on its own at every notice: what, why and the deadline (it is all you will remember). Reminders that fall in the user's quiet hours are moved to when they end; the result says so.",
		parameters: {
			type: "object",
			properties: {
				when: { type: "string", description: 'When to follow up (single notice): ISO 8601 or e.g. "amanhã 9h", "daqui a 2 horas", "dia 13 às 18h". Optional when stages or deadline is given.' },
				stages: { type: "array", maxItems: 4, items: { type: "string" }, description: "Several notices for the SAME subject, in one follow-up (same formats as when; future only; max 4). Use instead of creating separate follow-ups." },
				note: { type: "string", description: "Self-contained text: what to remind or check, with the context needed. Max 1000 chars." },
				kind: { type: "string", enum: ["reminder", "check"], description: "reminder (default): just remind. check: do the task in the note (look things up) and report." },
				deadline: { type: "string", description: 'Optional: the due date (ISO 8601 or e.g. "dia 13/11"). Without stages, the server schedules staged notices up to it (early one, intermediates, 2-3 days before).' },
				important: { type: "boolean", description: "Optional, with deadline: also add a notice the day before." },
				inferred: { type: "boolean", description: `true when YOU decide to follow up on your own because the user's message implies a future check (\"o pedido deve chegar essa semana\"), without them asking. Forces kind=check (read-only, you message only if there is news), is scheduled silently (do not mention it) and at most ${FOLLOWUP_INFERRED_MAX_OPEN} can be open. Never set it when the user asked for a reminder.` },
			},
			required: ["note"],
		},
	},
};

export const LIST_FOLLOWUPS_TOOL: ChatTool = {
	type: "function",
	function: {
		name: LIST_FOLLOWUPS_TOOL_NAME,
		description: "List the pending follow-ups (reminders and checks) scheduled with schedule_followup, with their ids and times. Use it when the user asks what is scheduled, before cancelling one, or to avoid scheduling a duplicate.",
		parameters: { type: "object", properties: {} },
	},
};

export const CANCEL_FOLLOWUP_TOOL: ChatTool = {
	type: "function",
	function: {
		name: CANCEL_FOLLOWUP_TOOL_NAME,
		description: "Cancel a pending follow-up. Pass its `id` (from list_followups) or a distinctive part of its note. Use it only when the user asks to cancel or the follow-up is no longer relevant.",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "Follow-up id, or a distinctive part of its note." } },
			required: ["id"],
		},
	},
};

export const RESCHEDULE_FOLLOWUP_TOOL: ChatTool = {
	type: "function",
	function: {
		name: RESCHEDULE_FOLLOWUP_TOOL_NAME,
		description:
			"Move a pending follow-up to a new time instead of creating a duplicate. Use it when the user says things like \"me lembra disso amanhã\" or \"adia esse lembrete\" about a reminder that already exists. Pass its `id` (from list_followups) or a distinctive part of its note, and `when` (same formats as schedule_followup; future only). A follow-up with several notices moves its next pending notice, or the one given in `stage` (1 = first). Reminders in quiet hours are moved to when they end; the result says so.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Follow-up id, or a distinctive part of its note." },
				when: { type: "string", description: 'New time: ISO 8601 or e.g. "amanhã 9h", "dia 13 às 18h".' },
				stage: { type: "number", description: "Which notice to move (1 = first). Default: the next pending one." },
			},
			required: ["id", "when"],
		},
	},
};

export const SUGGEST_ROUTINE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SUGGEST_ROUTINE_TOOL_NAME,
		description:
			"Offer a recurring routine you noticed the user needs (the same request again and again, a periodic check they keep asking for). Depending on the user's setting it either shows a card asking whether to create it, or creates it and tells them (they can undo). Use it ONLY for your own idea, at most once per pattern, and never when the user is already asking for a routine (use propose_routine then). Do not use it for one-off reminders (schedule_followup) or if a similar routine exists. `prompt` is the instruction you will follow on every run. Give a 5-field `cron` (e.g. \"0 8 * * 1\" = Mondays 08:00) or `every_minutes`, not both.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short routine name in the user's language (max 80 chars)." },
				prompt: { type: "string", description: "Instruction to follow at each run, self-contained." },
				cron: { type: "string", description: "5-field cron expression in the given timezone." },
				every_minutes: { type: "number", description: `Fixed interval, ${INTERVAL_EVERY_MINUTES_MIN} to ${INTERVAL_EVERY_MINUTES_MAX} minutes.` },
				timezone: { type: "string", description: "IANA timezone; defaults to the user's." },
			},
			required: ["name", "prompt"],
		},
	},
};

export const NOTIFY_USER_TOOL: ChatTool = {
	type: "function",
	function: {
		name: NOTIFY_USER_TOOL_NAME,
		description:
			"Send the user one message in their chat, on your own initiative. This is the only way to message them from the background reflection. Use it only for something concrete and useful now (a heads-up tied to a deadline, a research result they would want). 1 to 3 sentences in the user's language. The server may refuse it (quiet hours, daily limit, or a relevance check): then stop, do not retry or rephrase.",
		parameters: {
			type: "object",
			properties: { message: { type: "string", description: "The message, ready to show the user." } },
			required: ["message"],
		},
	},
};

/** Contexto do push avulso (rotina "só importante" ou chat longo): fala só com o dono do run. */
export type UserPushMode = "routine" | "chat";

const USER_PUSH_MAX_CHARS = 240;

export function notifyUserPushTool(mode: UserPushMode): ChatTool {
	const description =
		mode === "routine"
			? "Send the user a push notification about this routine run. The result of the run is already saved silently in the chat; call this only if what you found is something the user would want to know right now (a change, a problem, a deadline). Nothing new or routine: do not call it. At most once per run, 1 or 2 short sentences in the user's language, ready to show as the notification text. The server may refuse it (quiet hours, one per run): then stop, do not retry."
			: "Send the user a push notification while you keep working, for when they may have left the screen: a long task reached a meaningful stage, or something blocks you and needs their input. Do not use it to announce the final answer or that you finished: that is notified automatically. At most once per run, 1 or 2 short sentences in the user's language. The server may refuse it: then continue without retrying.";
	return {
		type: "function",
		function: {
			name: NOTIFY_USER_TOOL_NAME,
			description,
			parameters: {
				type: "object",
				properties: { message: { type: "string", description: "The notification text, ready to show the user." } },
				required: ["message"],
			},
		},
	};
}

export type UserPushContext = {
	mode: UserPushMode;
	/** Envia o push ao dono do run (o worker liga ao notifier; nunca outro destinatário). */
	send: (text: string) => Promise<void>;
	/** Silêncio do usuário, quando ele configurou o modo proativo. */
	quiet?: ProactiveSettings;
	/** Pushes já enviados neste run (teto 1). */
	sent: { used: number };
	now?: () => Date;
	log?: (line: string) => void;
};

/** `notify_user` fora da reflexão: só push (a resposta do run já está no chat), 1 por run, respeita o silêncio. */
export async function executeUserPush(args: Record<string, unknown>, ctx: UserPushContext): Promise<{ summary: string }> {
	const message = text(args.message);
	if (!message) throw new Error('Informe "message" com o texto da notificação.');
	if (message.length > USER_PUSH_MAX_CHARS) throw new Error(`Mensagem longa demais (máx. ${USER_PUSH_MAX_CHARS} caracteres): encurte.`);
	if (ctx.sent.used >= 1) {
		return { summary: JSON.stringify({ sent: false, reason: "one_per_run", note: "A notification was already sent in this run. Do not send another." }) };
	}
	const now = (ctx.now ?? (() => new Date()))();
	if (ctx.quiet && isInQuietHours(now, ctx.quiet)) {
		ctx.log?.(`notify_user mode=${ctx.mode} sent=false reason=quiet_hours`);
		return { summary: JSON.stringify({ sent: false, reason: "quiet_hours", note: "It is the user's quiet hours. Nothing was sent; the result stays in the chat. Do not retry." }) };
	}
	ctx.sent.used += 1;
	await ctx.send(message);
	ctx.log?.(`notify_user mode=${ctx.mode} sent=true chars=${message.length}`);
	return { summary: JSON.stringify({ sent: true, note: "The user was notified. Do not call this again in this run." }) };
}

export type ProactiveToolSet = "chat" | "reflection" | "followup";

/** Quais tools proativas entram no run: chat do bot principal, reflexão (sem conversa) ou run de lembrete. */
export function proactiveToolsFor(input: { origin: string | undefined; hasConversation: boolean }): ChatTool[] {
	if (input.origin === "chat") return [SCHEDULE_FOLLOWUP_TOOL, LIST_FOLLOWUPS_TOOL, CANCEL_FOLLOWUP_TOOL, RESCHEDULE_FOLLOWUP_TOOL, SUGGEST_ROUTINE_TOOL];
	if (input.origin === "proactive" && !input.hasConversation) return [SCHEDULE_FOLLOWUP_TOOL, LIST_FOLLOWUPS_TOOL, SUGGEST_ROUTINE_TOOL, NOTIFY_USER_TOOL];
	if (input.origin === "proactive") return [SCHEDULE_FOLLOWUP_TOOL, LIST_FOLLOWUPS_TOOL, CANCEL_FOLLOWUP_TOOL, RESCHEDULE_FOLLOWUP_TOOL];
	return [];
}

export const PROACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
	SCHEDULE_FOLLOWUP_TOOL_NAME,
	LIST_FOLLOWUPS_TOOL_NAME,
	CANCEL_FOLLOWUP_TOOL_NAME,
	RESCHEDULE_FOLLOWUP_TOOL_NAME,
	SUGGEST_ROUTINE_TOOL_NAME,
	NOTIFY_USER_TOOL_NAME,
]);

export type ProactiveToolContext = {
	userId: string | undefined;
	botId: string | undefined;
	runId?: string;
	origin: string | undefined;
	conversationId?: string;
	settings: ProactiveSettings;
	/** Reflexão diária: sem conversa, sem humano, limites mais duros. */
	reflection: boolean;
	/** Ações já feitas neste run (reflexão). */
	actions: { used: number };
	jev?: JevRuntime;
	now?: () => Date;
	onRoutineMutated?: (routine: Pick<RoutineRecord, "id" | "enabled" | "schedule" | "timezone" | "triggerType" | "once" | "interval">) => Promise<void>;
	log?: (line: string) => void;
	abortSignal?: AbortSignal;
};

export type ProactiveToolDeps = {
	createFollowup: typeof createFollowup;
	listFollowups: typeof listFollowups;
	cancelFollowup: typeof cancelFollowup;
	rescheduleOwnedFollowup: typeof rescheduleOwnedFollowup;
	listRoutines: typeof listRoutines;
	createRoutineFromProposal: typeof createRoutineFromProposal;
	appendRoutineProposalCard: typeof appendRoutineProposalCard;
	findRecentProposalByName: typeof findRecentProposalByName;
	getBotConversationId: typeof getBotConversationId;
	appendMessage: typeof appendConversationMessage;
	reserve: typeof reserveProactiveMessage;
	recordEvent: typeof recordProactiveEvent;
};

export const defaultProactiveDeps: ProactiveToolDeps = {
	createFollowup,
	listFollowups,
	cancelFollowup,
	rescheduleOwnedFollowup,
	listRoutines,
	createRoutineFromProposal,
	appendRoutineProposalCard,
	findRecentProposalByName,
	getBotConversationId,
	appendMessage: appendConversationMessage,
	reserve: reserveProactiveMessage,
	recordEvent: recordProactiveEvent,
};

function requireScope(ctx: ProactiveToolContext): { userId: string; botId: string } {
	if (!ctx.userId || ctx.userId === "default" || !ctx.botId) throw new Error("Sem usuário ou bot neste run: modo proativo indisponível.");
	return { userId: ctx.userId, botId: ctx.botId };
}

function say(ctx: ProactiveToolContext, line: string): void {
	(ctx.log ?? ((text: string) => console.log(text)))(`[proactive] ${line}`);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Reflexão: no máximo N ações por execução (o resto é ignorado com uma nota ao modelo). */
function overActionBudget(ctx: ProactiveToolContext): string | null {
	if (!ctx.reflection) return null;
	if (ctx.actions.used >= PROACTIVE_MAX_ACTIONS_PER_REFLECTION) {
		return JSON.stringify({ done: false, reason: "action_limit", note: "Action limit for this reflection reached. Stop now and reply DONE." });
	}
	return null;
}

/** Horários dos avisos: `stages` explícitos > escalonados a partir de `deadline` > `when` único. */
function resolveStageDates(
	args: Record<string, unknown>,
	now: Date,
	settings: ProactiveSettings,
): { requested: Date[]; effective: Date[] } {
	const tz = settings.timezone;
	const explicit = Array.isArray(args.stages) ? args.stages.map((item) => text(item)).filter(Boolean) : [];
	if (explicit.length > FOLLOWUP_STAGES_MAX) throw new Error(`stages: no máximo ${FOLLOWUP_STAGES_MAX} avisos por lembrete.`);
	let requested: Date[] = [];
	if (explicit.length > 0) {
		requested = explicit.map((raw) => {
			const resolved = resolveFollowupWhen(raw, now, tz);
			if (!resolved.ok) throw new Error(`stages inválido ("${raw.slice(0, 40)}"): ${resolved.error}`);
			return resolved.dueAt;
		});
	} else if (text(args.deadline)) {
		const deadline = resolveFollowupWhen(text(args.deadline), now, tz);
		if (!deadline.ok) throw new Error(`deadline inválido: ${deadline.error}`);
		requested = suggestReminderStages(now, deadline.dueAt, tz, { important: args.important === true, settings });
	}
	if (requested.length === 0) {
		if (!text(args.when)) throw new Error('Informe "when" (um aviso), "stages" (vários avisos do mesmo assunto) ou "deadline".');
		const resolved = resolveFollowupWhen(text(args.when), now, tz);
		if (!resolved.ok) throw new Error(`when inválido: ${resolved.error}`);
		requested = [resolved.dueAt];
	}
	requested = [...requested].sort((a, b) => a.getTime() - b.getTime());
	const effective = normalizeNewStages(requested.map((at) => nextAllowedTime(at, settings)));
	return { requested, effective };
}

export async function executeScheduleFollowup(
	args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	const { userId, botId } = requireScope(ctx);
	const over = overActionBudget(ctx);
	if (over) return { summary: over };
	const note = text(args.note);
	if (!note) throw new Error('Informe "note" com o que lembrar ou verificar (texto completo, que faça sentido sozinho).');
	const inferred = args.inferred === true && !ctx.reflection;
	const kind = inferred || args.kind === "check" ? "check" : "reminder";
	if (inferred) {
		const open = (await deps.listFollowups(userId, botId, { limit: 100 })).filter((item) => item.kind === "check" && item.source === "chat");
		if (open.length >= FOLLOWUP_INFERRED_MAX_OPEN) {
			return { summary: JSON.stringify({ scheduled: false, reason: "inferred_limit", note: `There are already ${open.length} open inferred follow-ups. Do not schedule another and do not mention this to the user.` }) };
		}
	}
	const now = (ctx.now ?? (() => new Date()))();
	const { requested, effective } = resolveStageDates(args, now, ctx.settings);
	const requestedFor = requested[0]!;
	const dueAt = effective[0]!;
	const movedForQuietHours = effective.some((at, i) => requested[i] !== undefined && at.getTime() !== requested[i]!.getTime());
	try {
		const { followup, duplicate } = await deps.createFollowup({
			userId,
			botId,
			note,
			kind,
			dueAt,
			requestedFor,
			stages: effective,
			source: ctx.reflection ? "reflection" : "chat",
			sourceRunId: ctx.runId ?? null,
		});
		if (!duplicate) ctx.actions.used += 1;
		say(ctx, `schedule_followup bot=${botId} followup=${followup.id} kind=${kind} source=${ctx.reflection ? "reflection" : "chat"} stages=${effective.length} duplicate=${duplicate} deferredByQuiet=${movedForQuietHours}`);
		return {
			summary: JSON.stringify({
				scheduled: !duplicate,
				alreadyScheduled: duplicate,
				id: followup.id,
				kind,
				at: formatFollowupDue(followup.dueAt, ctx.settings.timezone),
				...(effective.length > 1 ? { stages: effective.map((at) => formatFollowupDue(at, ctx.settings.timezone)) } : {}),
				...(movedForQuietHours
					? { movedForQuietHours: true, requestedAt: formatFollowupDue(requestedFor, ctx.settings.timezone) }
					: {}),
				note: inferred
					? "Scheduled silently on your own initiative. Do NOT mention it to the user (no confirmation, no card); answer what the user said as usual. You will come back at that time with the update, or stay quiet if nothing changed."
					: duplicate
					? "The same follow-up was already scheduled. Tell the user it is already set."
					: effective.length > 1
						? "Scheduled as ONE follow-up with several notices. Confirm to the user in one short sentence the subject and the dates (use 'stages'; mention any that moved if movedForQuietHours). Do not create other follow-ups for this subject."
						: "Scheduled. Confirm to the user in one short sentence what and when (use the 'at' value; mention it moved if movedForQuietHours).",
			}),
		};
	} catch (error) {
		if (error instanceof FollowupError) throw new Error(error.message);
		throw error;
	}
}

export async function executeListFollowups(
	_args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	const { userId, botId } = requireScope(ctx);
	const items = await deps.listFollowups(userId, botId, { limit: 30 });
	if (items.length === 0) return { summary: "Nenhum lembrete pendente." };
	return {
		summary: items
			.map((item) => {
				const stages = item.stages ?? [];
				const total = stages.length;
				const extra = total > 1 ? ` | notices ${stages.filter((st) => st.firedAt).length + 1}/${total}: ${stages.map((st) => `${formatFollowupDue(new Date(st.at), ctx.settings.timezone)}${st.firedAt ? " (sent)" : ""}`).join("; ")}` : "";
				return `- ${item.id} | ${formatFollowupDue(item.dueAt, ctx.settings.timezone)} | ${item.kind} | ${item.note.slice(0, 160)}${extra}`;
			})
			.join("\n"),
	};
}

export async function executeCancelFollowup(
	args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	const { userId, botId } = requireScope(ctx);
	const needle = text(args.id);
	if (!needle) throw new Error('Informe "id" (de list_followups) ou parte do texto do lembrete.');
	const items = await deps.listFollowups(userId, botId, { limit: 100 });
	const lower = needle.toLowerCase();
	const matches = items.filter((item) => item.id === needle || item.note.toLowerCase().includes(lower));
	if (matches.length === 0) throw new Error("Nenhum lembrete pendente combina com esse id/texto. Use list_followups.");
	if (matches.length > 1) {
		throw new Error(`Mais de um lembrete combina:\n${matches.map((m) => `- ${m.id} | ${m.note.slice(0, 80)}`).join("\n")}\nUse o id exato.`);
	}
	const target = matches[0]!;
	const ok = await deps.cancelFollowup(userId, target.id, botId);
	if (!ok) throw new Error("O lembrete já não está pendente.");
	say(ctx, `cancel_followup bot=${botId} followup=${target.id}`);
	return { summary: JSON.stringify({ cancelled: true, id: target.id, note: "Tell the user it was cancelled." }) };
}

export async function executeRescheduleFollowup(
	args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	const { userId, botId } = requireScope(ctx);
	const needle = text(args.id);
	if (!needle) throw new Error('Informe "id" (de list_followups) ou parte do texto do lembrete.');
	const when = text(args.when);
	if (!when) throw new Error('Informe "when" com o novo horário.');
	const now = (ctx.now ?? (() => new Date()))();
	const check = planFollowupReschedule({ when, now, settings: ctx.settings });
	if (!check.ok) throw new Error(`when inválido: ${check.error}`);
	const items = await deps.listFollowups(userId, botId, { limit: 100 });
	const lower = needle.toLowerCase();
	const matches = items.filter((item) => item.id === needle || item.note.toLowerCase().includes(lower));
	if (matches.length === 0) throw new Error("Nenhum lembrete pendente combina com esse id/texto. Use list_followups.");
	if (matches.length > 1) {
		throw new Error(`Mais de um lembrete combina:\n${matches.map((m) => `- ${m.id} | ${m.note.slice(0, 80)}`).join("\n")}\nUse o id exato.`);
	}
	const target = matches[0]!;
	const stage = typeof args.stage === "number" && Number.isInteger(args.stage) && args.stage >= 1 ? args.stage : undefined;
	const result = await deps.rescheduleOwnedFollowup({ userId, botId, followupId: target.id, when, ...(stage !== undefined ? { stage } : {}), now });
	if (!result.ok) throw new Error(result.error);
	say(ctx, `reschedule_followup bot=${botId} followup=${target.id} deferredByQuiet=${result.movedForQuietHours}`);
	return {
		summary: JSON.stringify({
			rescheduled: true,
			id: target.id,
			at: formatFollowupDue(result.followup.dueAt, ctx.settings.timezone),
			...(result.followup.stages.length > 1 ? { stages: result.followup.stages.map((st) => `${formatFollowupDue(new Date(st.at), ctx.settings.timezone)}${st.firedAt ? " (sent)" : ""}`) } : {}),
			...(result.movedForQuietHours ? { movedForQuietHours: true, requestedAt: formatFollowupDue(result.requestedFor, ctx.settings.timezone) } : {}),
			note: "Moved. Confirm to the user in one short sentence the new time (use 'at'; mention it moved if movedForQuietHours).",
		}),
	};
}

/** Jev e depois silêncio/teto. Só quem fala sem o usuário na conversa precisa passar por aqui. */
async function gateUnsolicitedPost(
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps,
	post: { kind: "message" | "routine"; description: string },
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
	const { userId, botId } = requireScope(ctx);
	const now = (ctx.now ?? (() => new Date()))();
	const answers = await decideWithJev({
		rt: ctx.jev,
		feature: "proactive",
		signal: ctx.abortSignal,
		state: {
			question: "Proactive message from an assistant to its user, sent unprompted.",
			kind: post.kind,
			proposedMessage: clipForJev(post.description, 800),
			localTime: now.toISOString(),
		},
		questions: {
			worth_interrupting: {
				instructions: "Is it worth interrupting the user right now with this message? Judge only the proposed message.",
				criteria: {
					true: "Concrete, timely and useful to the user right now",
					false: "Generic, repetitive, or not worth an interruption",
				},
			},
		},
	});
	const probability = answers?.answers.worth_interrupting;
	const jevMode = ctx.jev?.modes?.proactive ?? "off";
	if (answers && jevMode === "on" && !jevYes(probability, PROACTIVE_JEV_THRESHOLD)) {
		say(ctx, `gate bot=${botId} kind=${post.kind} result=blocked reason=jev p=${probability?.toFixed(2)}`);
		return { allowed: false, reason: "jev" };
	}
	const gate: ProactiveGate = await deps.reserve({
		userId,
		botId,
		settings: ctx.settings,
		now,
		runId: ctx.runId ?? null,
		detail: post.kind,
	});
	if (!gate.allowed) {
		say(ctx, `gate bot=${botId} kind=${post.kind} result=blocked reason=${gate.reason}`);
		return { allowed: false, reason: gate.reason };
	}
	say(ctx, `gate bot=${botId} kind=${post.kind} result=allowed jev=${answers ? jevMode : "none"}`);
	return { allowed: true };
}

function refusedSummary(reason: string): { summary: string } {
	const why =
		reason === "quiet_hours"
			? "It is the user's quiet hours."
			: reason === "daily_cap"
				? "The daily limit of proactive messages was reached."
				: "It was judged not worth interrupting the user.";
	return {
		summary: JSON.stringify({ sent: false, reason, note: `${why} Nothing was sent. Do not retry or rephrase; stop and reply DONE.` }),
	};
}

export async function executeNotifyUser(
	args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	const { userId, botId } = requireScope(ctx);
	if (!ctx.reflection) throw new Error("notify_user só existe na reflexão em segundo plano; no chat, responda normalmente.");
	const over = overActionBudget(ctx);
	if (over) return { summary: over };
	const message = text(args.message);
	if (!message) throw new Error('Informe "message" com o texto para o usuário.');
	if (message.length > NOTIFY_MAX_CHARS) throw new Error(`Mensagem longa demais (máx. ${NOTIFY_MAX_CHARS} caracteres): encurte.`);
	const conversationId = ctx.conversationId ?? (await deps.getBotConversationId(botId, userId));
	if (!conversationId) throw new Error("O bot ainda não tem conversa: mensagem não enviada.");
	const gate = await gateUnsolicitedPost(ctx, deps, { kind: "message", description: message });
	if (!gate.allowed) return refusedSummary(gate.reason);
	await deps.appendMessage(conversationId, "assistant", message);
	ctx.actions.used += 1;
	say(ctx, `notify_user bot=${botId} run=${ctx.runId ?? "-"} sent=true chars=${message.length}`);
	return { summary: JSON.stringify({ sent: true, note: "The message is now in the user's chat. Do not repeat it; reply DONE unless another action is still needed." }) };
}

function buildSpec(args: Record<string, unknown>, ctx: ProactiveToolContext): RoutineProposalSpec {
	const name = text(args.name).slice(0, 80);
	const prompt = text(args.prompt);
	if (!name) throw new Error('Informe "name" (nome curto da rotina).');
	if (!prompt) throw new Error('Informe "prompt" (a instrução que você segue a cada execução).');
	const cron = text(args.cron);
	const every = typeof args.every_minutes === "number" ? args.every_minutes : undefined;
	if (cron && every !== undefined) throw new Error("Use cron OU every_minutes, não os dois.");
	if (!cron && every === undefined) throw new Error('Informe "cron" (5 campos) ou "every_minutes".');
	if (cron && !isCronFive(cron)) throw new Error(`cron inválido "${cron}": use 5 campos (ex.: 0 8 * * 1).`);
	if (every !== undefined && (!Number.isInteger(every) || every < INTERVAL_EVERY_MINUTES_MIN || every > INTERVAL_EVERY_MINUTES_MAX)) {
		throw new Error(`every_minutes deve ser inteiro de ${INTERVAL_EVERY_MINUTES_MIN} a ${INTERVAL_EVERY_MINUTES_MAX}.`);
	}
	const timezone = text(args.timezone) || ctx.settings.timezone;
	const spec = parseRoutineProposalSpec({ name, prompt, timezone, ...(cron ? { schedule: cron } : { everyMinutes: every }) });
	if (!spec) throw new Error("Proposta de rotina inválida: confira nome, instrução e agenda.");
	return spec;
}

export async function executeSuggestRoutine(
	args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	const { userId, botId } = requireScope(ctx);
	const over = overActionBudget(ctx);
	if (over) return { summary: over };
	const spec = buildSpec(args, ctx);

	const existing = await deps.listRoutines(userId, botId);
	const duplicate = findDuplicateRoutine(existing, { name: spec.name, prompt: spec.prompt, schedule: spec.schedule ?? null });
	if (duplicate) {
		say(ctx, `suggest_routine bot=${botId} result=duplicate_routine`);
		return { summary: JSON.stringify({ created: false, reason: "similar_routine_exists", routine: duplicate.name, note: "A similar routine already exists. Do not suggest it again." }) };
	}
	const conversationId = ctx.conversationId ?? (await deps.getBotConversationId(botId, userId));
	if (!conversationId) throw new Error("O bot ainda não tem conversa: sugestão não enviada.");
	const previous = await deps.findRecentProposalByName(conversationId, spec.name);
	if (previous) {
		say(ctx, `suggest_routine bot=${botId} result=duplicate_proposal status=${previous.status}`);
		return {
			summary: JSON.stringify({ created: false, reason: "already_proposed", status: previous.status, note: "This routine was already proposed to the user. Do not propose it again." }),
		};
	}

	if (ctx.reflection) {
		const gate = await gateUnsolicitedPost(ctx, deps, {
			kind: "routine",
			description: `Routine idea: ${spec.name} (${spec.schedule ?? `every ${spec.everyMinutes} min`})`,
		});
		if (!gate.allowed) return refusedSummary(gate.reason);
	}

	const mode = ctx.settings.routineMode;
	const proposalId = `proposal-${ctx.runId ?? "run"}-${Math.random().toString(36).slice(2, 8)}`;
	let card: PersistedRoutineProposalCard = { v: 1, kind: "routine-proposal", proposalId, mode, status: "pending", spec };

	if (mode === "auto") {
		const outcome = await deps.createRoutineFromProposal(userId, botId, spec);
		if ("duplicate" in outcome) {
			return { summary: JSON.stringify({ created: false, reason: "similar_routine_exists", routine: outcome.duplicate.name, note: "A similar routine already exists." }) };
		}
		await ctx.onRoutineMutated?.(outcome.routine).catch(() => undefined);
		card = { ...card, routineId: outcome.routine.id };
	}
	await deps.appendRoutineProposalCard(conversationId, card);
	ctx.actions.used += 1;
	await deps.recordEvent({ userId, botId, kind: "routine", runId: ctx.runId ?? null, detail: mode }).catch(() => undefined);
	say(ctx, `suggest_routine bot=${botId} mode=${mode} result=${mode === "auto" ? "created" : "proposed"} reflection=${ctx.reflection}`);
	return {
		summary: JSON.stringify(
			mode === "auto"
				? { created: true, mode, note: 'The routine was created and a card tells the user ("Criei a rotina… manter?" with an Undo button). Mention it in one sentence if you are replying in chat.' }
				: { proposed: true, mode, note: "A card now asks the user whether to create it (Create / Not now). Nothing exists yet. Mention the idea in one sentence if you are replying in chat; do not insist." },
		),
	};
}

export async function executeProactiveTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ProactiveToolContext,
	deps: ProactiveToolDeps = defaultProactiveDeps,
): Promise<{ summary: string }> {
	switch (name) {
		case SCHEDULE_FOLLOWUP_TOOL_NAME:
			return executeScheduleFollowup(args, ctx, deps);
		case LIST_FOLLOWUPS_TOOL_NAME:
			return executeListFollowups(args, ctx, deps);
		case CANCEL_FOLLOWUP_TOOL_NAME:
			return executeCancelFollowup(args, ctx, deps);
		case RESCHEDULE_FOLLOWUP_TOOL_NAME:
			return executeRescheduleFollowup(args, ctx, deps);
		case SUGGEST_ROUTINE_TOOL_NAME:
			return executeSuggestRoutine(args, ctx, deps);
		case NOTIFY_USER_TOOL_NAME:
			return executeNotifyUser(args, ctx, deps);
		default:
			throw new Error(`Tool proativa desconhecida: ${name}`);
	}
}
