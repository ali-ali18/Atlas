import { skillScope } from "../helpers.js";
import { b3QuotePageReason, describeRoutineProposalSchedule } from "@workspace/shared";
import type { RoutineRecord } from "@workspace/shared";
import {
	isCronFive,
	describeGithubTrigger,
	describeEmailTrigger,
	parseEmailTriggerInput,
	parseGithubTriggerInput,
	resolveOnceRunAt,
	formatOnceSummary,
	parseIntervalEveryMinutes,
	normalizeGithubRepo,
	buildGithubSecurityReviewPrompt,
	DAILY_BRIEF_TEMPLATE,
	describeBriefSources,
	formatDailyBriefSummary,
	parseDailyBriefSchedule,
	type RoutineNotifyMode,
	GITHUB_SECURITY_REVIEW_TEMPLATE,
	formatIntervalSummary,
	clampAlertRuleInterval,
	defaultAlertRuleInterval,
	describeRoutineAlertSentence,
	parseRoutineAlertInput,
	validateAlertInterval,
	type RoutineAlertConfig,
} from "@workspace/shared";
import {
	createRoutine,
	convertRoutineToGenericWebhook,
	deleteRoutine,
	deleteRoutineGroup,
	updateRoutineGroup,
	findOrCreateRoutineGroup,
	hookPublicUrl,
	listRoutineGroups,
	listRoutines,
	normalizeRoutineGroupName,
	setRoutineGroupEnabled,
	persistConversationCardFromEvent,
	updateRoutine,
} from "@workspace/db";
import { ensureGithubRepoHook } from "../../../github/hook-sync.js";
import type { RoutineEvent, ToolContext, ToolResult } from "../types.js";
export { executeAgentMemoryTool, type AgentMemoryDeps } from "../../registry/handlers/memory.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { ROUTINE_CONTROL_TOOL_NAME, executeRoutineControl } from "../../routine-control.js";
import { REPORT_ALERT_TOOL_NAME, executeReportAlert } from "../../report-alert.js";
import { alertRuleReadingNote, ownerAlertRuleReader, testAlertRule } from "../../alert-rule.js";
import { FIND_PAGE_VALUE_TOOL_NAME, executeFindPageValue } from "../../find-page-value.js";
import { upsertDailyBrief } from "../../daily-brief.js";
import { listBriefSources } from "../../daily-brief-sources.js";
import { dbPagesStore } from "../../pages.js";

import type { ToolFamily } from "../registry.js";

async function handleListRoutines(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeListRoutines(args, ctx);
}

async function handleRoutineGroup(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeRoutineGroup(args, ctx);
}

async function handleRoutineControl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeRoutineControlTool(args, ctx);
}

async function handleProposeRoutine(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeProposeRoutine(args, ctx);
}

async function handleReportAlert(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	if (!ctx.alertRun) throw new Error("report_alert só existe em execução de rotina de alerta.");
	return executeReportAlert(args, ctx.alertRun);
}

async function handleFindPageValue(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeFindPageValue(args, ctx.pageValueFinder, ctx.pageValueUse);
}

/** Família `routines`. */
export const ROUTINES_TOOLS: ToolFamily = {
	"list_routines": { group: "routines", handler: handleListRoutines },
	"routine_group": { group: "routines", handler: handleRoutineGroup },
	[ROUTINE_CONTROL_TOOL_NAME]: { group: "routines", handler: handleRoutineControl },
	"propose_routine": { group: "routines", handler: handleProposeRoutine },
	[REPORT_ALERT_TOOL_NAME]: { group: "routines", handler: handleReportAlert },
	[FIND_PAGE_VALUE_TOOL_NAME]: { group: "routines", handler: handleFindPageValue },
};

export async function emitRoutineCard(
	ctx: ToolContext,
	event: RoutineEvent,
): Promise<RoutineEvent> {
	await persistConversationCardFromEvent(ctx.conversationId, event).catch(() => undefined);
	return event;
}

/**
 * Edição de rotina (cron, event genérico ou github): dispara o evento SSE
 * "routine"/updated pra web recarregar a lista (side panel não fica com
 * dado velho), mas SEM persistir card na timeline — edição nunca teve card,
 * só criação (ver `emitRoutineCard`/`persistConversationCardFromEvent`).
 */
export function routineUpdatedEvent(routine: RoutineRecord): RoutineEvent {
	return {
		type: "routine",
		action: "updated",
		routineId: routine.id,
		title: routine.name,
		triggerType: routine.triggerType,
		detail: routineDetailText(routine),
	};
}

/** Falta de caixa vira dica acionável (o agente sabe criar a caixa); o resto da mensagem passa como está. */
export function emailTriggerErrorWithHint(error: unknown): string {
	const message = error instanceof Error ? error.message : "falha ao salvar o gatilho de e-mail";
	return message.includes("aba E-mail") ? `${message}. Se o usuário quiser, crie a caixa com email_create_mailbox e tente de novo.` : message;
}

export function routineDetailText(
	routine: RoutineRecord,
	hookSecret?: string,
	briefSourcesSentence?: string,
): string {
	if (routine.triggerType === "event") {
		if (routine.email) {
			return [describeEmailTrigger(routine.email), "", routine.prompt].join("\n");
		}
		if (routine.github) {
			return [
				`GitHub: ${describeGithubTrigger(routine.github)}`,
				"",
				routine.prompt,
			].join("\n");
		}
		const url =
			routine.hook?.url ??
			(routine.hook?.hookKey ? hookPublicUrl(routine.hook.hookKey) : "");
		return [
			url ? `Webhook: ${url}` : null,
			hookSecret ? `Secret (guarde agora): ${hookSecret}` : null,
			"Header: X-Atlas-Hook-Secret: <secret>",
			"",
			routine.prompt,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n");
	}
	if (routine.template === DAILY_BRIEF_TEMPLATE) {
		return [
			formatDailyBriefSummary({ schedule: routine.schedule, enabled: routine.enabled }),
			"Te mando um resumo curto no chat, no horário combinado. Só leio suas fontes: não envio, aceito nem apago nada.",
			...(briefSourcesSentence ? [briefSourcesSentence] : []),
			`Ativa: ${routine.enabled ? "sim" : "não"}`,
		].join("\n");
	}
	const alertSentence = describeRoutineAlertSentence(routine);
	if (alertSentence) {
		return [alertSentence, "Verifica sozinho e só avisa quando a condição passa a valer.", `Ativa: ${routine.enabled ? "sim" : "não"}`, "", routine.prompt].join("\n");
	}
	if (routine.triggerType === "interval") {
		return [
			formatIntervalSummary(routine.interval?.everyMinutes ?? 0),
			"Repete no intervalo indicado, contado desde a última execução agendada.",
			"",
			routine.prompt,
		].join("\n");
	}
	if (routine.triggerType === "once") {
		return [
			formatOnceSummary(routine.once?.runAt ?? "", routine.timezone),
			"Dispara uma vez e some — a rotina se apaga sozinha depois de rodar.",
			"",
			routine.prompt,
		].join("\n");
	}
	return [
		`Cron: ${routine.schedule ?? "—"} (${routine.timezone})`,
		`Ativa: ${routine.enabled ? "sim" : "não"}`,
		"",
		routine.prompt,
	].join("\n");
}

export async function executeListRoutines(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string }> {
	const scope = skillScope(ctx);
	if (!scope) {
		return { summary: "Rotinas indisponíveis: este run não tem bot vinculado." };
	}
	if (ctx.origin === "routine") {
		return {
			summary:
				"Este run é execução de rotina. Não liste/crie rotinas — execute a instrução.",
		};
	}
	const onlyEnabled = Boolean(args.only_enabled);
	const rows = await listRoutines(scope.userId, scope.botId);
	const onlyAlerts = Boolean(args.only_alerts);
	const filtered = rows.filter((row) => (!onlyEnabled || row.enabled) && (!onlyAlerts || row.alert));
	const items = filtered.slice(0, 25);
	if (items.length === 0) {
		return { summary: onlyAlerts ? "Nenhum alerta neste bot." : "Nenhuma rotina neste bot." };
	}
	const lines = items.map((row, index) => {
		const kind =
			row.triggerType === "event"
				? (row.email
					? `e-mail (${describeEmailTrigger(row.email)})`
					: row.github
					? `GitHub (${describeGithubTrigger(row.github)})`
					: `webhook${row.hook?.hookKey ? ` · ${row.hook.hookKey}` : ""}`)
				: row.triggerType === "once"
					? formatOnceSummary(row.once?.runAt ?? "", row.timezone)
					: row.triggerType === "interval"
						? formatIntervalSummary(row.interval?.everyMinutes ?? 0)
						: describeRoutineProposalSchedule({ schedule: row.schedule ?? undefined });
		const state = row.enabled ? "ativa" : "pausada";
		const groupNote = row.group ? ` [grupo: ${row.group.name}]` : "";
		const alertSentence = describeRoutineAlertSentence(row);
		const alertNote = alertSentence ? ` — ${alertSentence}${row.alert?.active ? " (avisando agora: condição ainda vale)" : ""}` : "";
		const notifyNote = !row.alert && row.notify === "important" ? " [aviso: só o importante]" : "";
		// O que a rotina faz: sem isso o bot não sabe responder "o que tem na rotina X?".
		const task = row.prompt?.replace(/\s+/g, " ").trim();
		const taskNote = task ? `\n   faz: ${task.length > 280 ? `${task.slice(0, 279)}…` : task}` : "";
		return `${index + 1}. ${row.name} (${kind}, ${state})${groupNote}${alertNote}${notifyNote}${taskNote}`;
	});
	return {
		summary: `Rotinas (${items.length}):\n${lines.join("\n")}`,
	};
}

export async function executeRoutineControlTool(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; routineEvent?: RoutineEvent }> {
	const scope = skillScope(ctx);
	if (!scope) return { summary: "Rotinas indisponíveis: este run não tem bot vinculado." };
	if (ctx.origin === "routine") {
		return { summary: "Este run é execução de rotina. Não gerencie rotinas — execute a instrução." };
	}
	const result = await executeRoutineControl(args, {
		resolve: (target) => resolveRoutineTarget(scope, target),
		update: (routineId, patch) => updateRoutine(scope.userId, scope.botId, routineId, patch),
		remove: (routineId) => deleteRoutine(scope.userId, scope.botId, routineId),
		onMutated: (routine) => ctx.onRoutineMutated?.(routine) ?? Promise.resolve(),
	});
	if (!result.routineEvent) return { summary: result.summary };
	const routineEvent = await emitRoutineCard(ctx, result.routineEvent);
	return { summary: result.summary, routineEvent };
}

export async function executeRoutineGroup(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; routineEvent?: RoutineEvent }> {
	const scope = skillScope(ctx);
	if (!scope) {
		return { summary: "Rotinas indisponíveis: este run não tem bot vinculado." };
	}
	if (ctx.origin === "routine") {
		return {
			summary:
				"Este run é execução de rotina. Não gerencie grupos — execute a instrução.",
		};
	}
	const action = String(args.action ?? "").trim();
	if (action !== "pause" && action !== "resume" && action !== "rename" && action !== "delete") {
		throw new Error("action deve ser pause, resume, rename ou delete");
	}
	const query = String(args.group ?? "").trim();
	if (!query) throw new Error("informe group (nome ou id do grupo)");
	const groups = await listRoutineGroups(scope.userId, scope.botId);
	const key = normalizeRoutineGroupName(query);
	const group =
		groups.find((row) => row.id === query) ??
		groups.find((row) => normalizeRoutineGroupName(row.name) === key);
	if (!group) {
		return { summary: `Não achei grupo "${query.slice(0, 80)}". Use list_routines.` };
	}
	if (action === "rename") {
		const newName = typeof args.new_name === "string" ? args.new_name.trim().replace(/\s+/g, " ") : "";
		if (!newName || newName.length > 80) throw new Error("rename exige new_name (até 80 caracteres)");
		const renamed = await updateRoutineGroup(scope.userId, scope.botId, group.id, { name: newName }).catch((error: unknown) => {
			throw new Error(error instanceof Error && error.message ? error.message : "Não consegui renomear o grupo agora.");
		});
		if (!renamed) return { summary: "Não consegui renomear o grupo agora." };
		return { summary: `Grupo "${group.name}" renomeado para "${renamed.name}". Rotinas e painéis do grupo continuam nele.` };
	}
	if (action === "delete") {
		const result = await deleteRoutineGroup(scope.userId, scope.botId, group.id);
		if (!result) return { summary: "Não consegui apagar o grupo agora." };
		const first = result.routines[0];
		return {
			summary: `Grupo "${group.name}" desfeito. As ${result.routines.length} rotinas continuam, sem grupo.`,
			...(first ? { routineEvent: routineUpdatedEvent({ ...first, groupId: null, group: null }) } : {}),
		};
	}
	const enabled = action === "resume";
	const routines = await setRoutineGroupEnabled(scope.userId, scope.botId, group.id, enabled);
	if (!routines) return { summary: "Não consegui atualizar o grupo agora." };
	for (const routine of routines) {
		await ctx.onRoutineMutated?.(routine).catch(() => undefined);
	}
	const repos = new Set(routines.flatMap((routine) => (routine.github ? [routine.github.repo] : [])));
	for (const repo of repos) {
		await ensureGithubRepoHook({ userId: scope.userId, repo }).catch(() => undefined);
	}
	const first = routines[0];
	return {
		summary: `Grupo "${group.name}": ${routines.length} rotinas ${enabled ? "ativadas" : "pausadas"}.`,
		...(first ? { routineEvent: routineUpdatedEvent(first) } : {}),
	};
}

export async function resolveRoutineTarget(
	scope: { userId: string; botId: string },
	query: string,
): Promise<
	| { kind: "one"; routine: RoutineRecord }
	| { kind: "none" }
	| { kind: "ambiguous"; lines: string }
> {
	const rows = await listRoutines(scope.userId, scope.botId);
	const q = query.trim().toLowerCase();
	if (!q) return { kind: "none" };
	const byId = rows.find((row) => row.id === query.trim());
	if (byId) return { kind: "one", routine: byId };
	const exact = rows.filter((row) => row.name.toLowerCase() === q);
	if (exact.length === 1) return { kind: "one", routine: exact[0]! };
	if (exact.length > 1) {
		return {
			kind: "ambiguous",
			lines: exact.map((row) => `- ${row.name} (${row.id})`).join("\n"),
		};
	}
	const partial = rows.filter((row) => row.name.toLowerCase().includes(q));
	if (partial.length === 1) return { kind: "one", routine: partial[0]! };
	if (partial.length > 1) {
		return {
			kind: "ambiguous",
			lines: partial
				.slice(0, 5)
				.map((row) => `- ${row.name} (${row.id})`)
				.join("\n"),
		};
	}
	return { kind: "none" };
}

/**
 * Args da tool (snake_case) → shape aceito por `parseGithubTriggerInput`
 * (camelCase). `branch` é o campo atual; `ci_branch` é o alias legado (ainda
 * aceito) — `branch` tem precedência quando os dois vierem.
 */
export function mapGithubToolArgs(raw: unknown): Record<string, unknown> {
	const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		repo: row.repo,
		events: row.events,
		prNumber: row.pr_number,
		users: row.users,
		branch: row.branch !== undefined ? row.branch : row.ci_branch,
	};
}

/** Alerta por intervalo curto só com pedido explícito do usuário (`alert.frequent`): cada conferência gasta uma execução do modelo. */
export function assertAlertIntervalAllowed(everyMinutes: number, rawAlert: unknown): void {
	const frequent = Boolean(rawAlert && typeof rawAlert === "object" && (rawAlert as Record<string, unknown>).frequent === true);
	const error = validateAlertInterval(everyMinutes, frequent);
	if (error) throw new Error(error);
}

/** Frase honesta das fontes que o brief lê (só categorias conectadas). Falha na consulta = sem promessa nenhuma. */
export async function briefSourcesSentence(userId: string): Promise<string> {
	try {
		return describeBriefSources(await listBriefSources(userId));
	} catch {
		return "";
	}
}

export async function executeDailyBriefTemplate(
	args: Record<string, unknown>,
	ctx: ToolContext,
	scope: { userId: string; botId: string },
): Promise<{ summary: string; routineEvent?: RoutineEvent }> {
	const { routine, created, sentence } = await upsertDailyBrief(args, {
		...scope,
	});
	await ctx.onRoutineMutated?.(routine).catch(() => undefined);
	const sources = await briefSourcesSentence(scope.userId);
	const sourcesNote = sources
		? ` Sources, say only this (never promise a site, portal or app that is not in it, e.g. a university portal): "${sources}"`
		: "";
	if (!created) {
		return {
			summary: `Rotina "${routine.name}" atualizada (sem card): ${sentence}. Responda em uma frase com "${sentence}".${sourcesNote}`,
			routineEvent: routineUpdatedEvent(routine),
		};
	}
	const routineEvent = await emitRoutineCard(ctx, {
		type: "routine",
		action: "created",
		routineId: routine.id,
		title: routine.name,
		triggerType: "cron",
		detail: routineDetailText(routine, undefined, sources),
	});
	return {
		summary: `Rotina "${routine.name}" criada: ${sentence}. O brief chega como mensagem no chat (e push) no horário combinado, sem painel. Card emitido só nesta criação. Responda em uma frase com "${sentence}".${sourcesNote}`,
		routineEvent,
	};
}

export async function executeProposeRoutine(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; routineEvent?: RoutineEvent }> {
	const scope = skillScope(ctx);
	if (!scope) {
		return { summary: "Rotinas indisponíveis: este run não tem bot vinculado." };
	}
	let action = String(args.action ?? "").trim();
	if (action !== "create" && action !== "edit") {
		throw new Error("action deve ser create ou edit");
	}
	if (ctx.origin === "routine") {
		return {
			summary:
				"Este run é execução de rotina. Não crie/edite rotinas — execute a instrução pedida.",
		};
	}
	let detail = String(args.detail ?? "").trim();
	if (args.template !== undefined && args.template !== GITHUB_SECURITY_REVIEW_TEMPLATE && args.template !== DAILY_BRIEF_TEMPLATE) {
		throw new Error(`template desconhecido: use "${GITHUB_SECURITY_REVIEW_TEMPLATE}", "${DAILY_BRIEF_TEMPLATE}" ou omita`);
	}
	if (args.template === DAILY_BRIEF_TEMPLATE) {
		// "Seu dia": uma por bot (pedir de novo edita a existente), cron de uma vez por dia, painel vinculado.
		return executeDailyBriefTemplate(args, ctx, scope);
	}
	if (action === "edit" && !detail && !args.template) {
		// Editar horário/dias/pausa do "Seu dia" não exige reenviar o prompt: ele só guarda o foco do usuário.
		const target = String(args.target ?? "").trim();
		const found = target ? await resolveRoutineTarget(scope, target) : null;
		if (found?.kind === "one" && found.routine.template === DAILY_BRIEF_TEMPLATE) detail = found.routine.prompt;
	}
	if (args.template === GITHUB_SECURITY_REVIEW_TEMPLATE) {
		const repo = normalizeGithubRepo(args.repo);
		if (!repo) {
			throw new Error(
				"template github_security_review exige repo no formato owner/name (use github_list_repos para resolver)",
			);
		}
		detail = buildGithubSecurityReviewPrompt({ repo, extra: detail });
	}
	if (!detail) throw new Error("detail vazio: descreva o prompt da rotina");
	const triggerTypeRaw = String(args.trigger_type ?? "").trim();
	if (
		triggerTypeRaw !== "cron" &&
		triggerTypeRaw !== "once" &&
		triggerTypeRaw !== "interval" &&
		triggerTypeRaw !== "event" &&
		triggerTypeRaw !== "github" &&
		triggerTypeRaw !== "email"
	) {
		throw new Error("trigger_type deve ser cron, once, interval, event, github ou email");
	}
	const triggerType = triggerTypeRaw as "cron" | "once" | "interval" | "event" | "github" | "email";
	// `undefined` = não informado: create assume true; edit preserva o
	// enabled/disabled atual da rotina (nunca reativa uma rotina pausada só
	// porque o argumento não veio no edit).
	const enabledArg = typeof args.enabled === "boolean" ? args.enabled : undefined;
	const enabled = enabledArg ?? true;
	const timezone = String(args.timezone ?? "").trim() || "America/Sao_Paulo";
	const model =
		typeof args.model === "string" && args.model.trim()
			? args.model.trim()
			: undefined;
	// Aviso: "important" = sem push automático, o bot avisa só quando vale; omitido mantém o atual (edit) ou "always" (create).
	let notify: RoutineNotifyMode | undefined = args.notify === "important" || args.notify === "always" ? args.notify : undefined;
	// `alert`: undefined = não informado (edit mantém); null = condição vazia (edit remove o alerta); objeto = liga/troca.
	let alertInput: RoutineAlertConfig | null | undefined;
	let alertReading: { display: string; note: string } | undefined;
	if (args.alert !== undefined && args.alert !== null) {
		const rawAlert = args.alert as Record<string, unknown>;
		const hasRule = typeof rawAlert === "object" && rawAlert.rule !== undefined && rawAlert.rule !== null;
		if (typeof rawAlert === "object" && typeof rawAlert.condition === "string" && !rawAlert.condition.trim() && !hasRule) {
			alertInput = null;
		} else {
			const ruleLocale = ctx.replyLanguage ?? "pt-BR";
			const parsedAlert = parseRoutineAlertInput(args.alert, { locale: ruleLocale });
			if (!parsedAlert.ok) throw new Error(parsedAlert.error);
			if (triggerType !== "cron" && triggerType !== "interval") {
				throw new Error("alert only works with trigger_type cron or interval (a routine that checks on a schedule). For a one-off reminder use once; for instant events use github/event.");
			}
			alertInput = parsedAlert.alert;
			if (alertInput.rule) {
				// Ticker da B3 em página de site de cotação: a fonte é sempre `quote` (brapi), nunca a página.
				const quoteSite = alertInput.rule.source.type === "page" ? b3QuotePageReason(alertInput.rule.source.url, [String(args.title ?? ""), detail, alertInput.condition, alertInput.hint, alertInput.rule.label, ctx.lastUserText]) : null;
				if (quoteSite) throw new Error(`Rule rejected: ${quoteSite}`);
				// Só grava a regra se ela lê agora (falha com motivo e dica; nada é criado). `expect` = o que a IA viu na página.
				const tested = await testAlertRule(alertInput.rule, ruleLocale, ctx.alertRuleReader ?? ownerAlertRuleReader(scope.userId), parsedAlert.expect);
				alertReading = { display: tested.display, note: alertRuleReadingNote(alertInput.rule, tested.display, tested.note) };
				if (tested.anchor) alertInput = { ...alertInput, rule: { ...alertInput.rule, anchor: tested.anchor } };
			}
		}
	}
	// Alerta com regra: o agente escolhe a frequência (every_minutes ou rule.intervalMinutes); só vale o piso técnico da fonte.
	const ruleEveryMinutes = (): number | undefined => {
		const rule = alertInput?.rule;
		if (!rule) return undefined;
		const explicit = Number(args.every_minutes);
		const wanted = Number.isFinite(explicit) && explicit > 0 ? explicit : (rule.intervalMinutes ?? defaultAlertRuleInterval(rule.source));
		return clampAlertRuleInterval(wanted, rule.source);
	};
	const alertSummaryTail = alertReading ? ` ${alertReading.note}` : "";
	const alertCreateFields = (): { alert?: RoutineAlertConfig } => (alertInput ? { alert: alertInput } : {});
	const alertEditFields = (): { alert?: RoutineAlertConfig | null } => (alertInput !== undefined ? { alert: alertInput } : {});
	const scheduleRaw =
		typeof args.schedule === "string" ? args.schedule.trim() : "";
	let existingOnCreate: RoutineRecord | undefined;
	// `page_id`: a página precisa ser deste bot e do usuário (o db confere de novo; aqui o erro já vem acionável).
	const pageIdRaw = typeof args.page_id === "string" ? args.page_id.trim() : undefined;
	if (pageIdRaw) {
		const page = await (ctx.pagesStore ?? dbPagesStore).get(pageIdRaw, scope.userId);
		if (!page || page.botId !== scope.botId) {
			throw new Error(`page_id ${pageIdRaw} not found for this bot. Use page_list to see its pages, or create the page first with page_create.`);
		}
	}
	const pageFields = (): { pageId?: string } => (pageIdRaw ? { pageId: pageIdRaw } : {});
	// `group` (nome): reaproveita o grupo de mesmo nome ou cria; só resolve depois da validação do gatilho.
	const groupName = typeof args.group === "string" ? args.group.trim() : "";
	const groupFields = async (): Promise<{ groupId?: string }> => {
		if (!groupName) return {};
		const { group } = await findOrCreateRoutineGroup(scope.userId, scope.botId, groupName);
		return { groupId: group.id };
	};

	if (action === "create") {
		const title =
			String(args.title ?? "").trim().slice(0, 120) || detail.slice(0, 80);
		const existing = await resolveRoutineTarget(scope, title);
		if (existing.kind === "ambiguous") {
			return {
				summary: `Já existem rotinas parecidas:\n${existing.lines}\nNão criei outra. Use action=edit com o target certo.`,
			};
		}
		if (existing.kind === "one") {
			// O mesmo nome é uma edição: passa por toda a validação e sincronização
			// do gatilho, inclusive GitHub e conversões cron/webhook.
			existingOnCreate = existing.routine;
			action = "edit";
		}
		if (action === "create" && triggerType === "cron") {
			if (enabled && !scheduleRaw) {
				throw new Error("cron ativo exige schedule (5 campos, ex.: 0 9 * * *)");
			}
			if (scheduleRaw && !isCronFive(scheduleRaw)) {
				throw new Error(
					`schedule inválido "${scheduleRaw}" — use 5 campos cron (ex.: 0 9 * * *)`,
				);
			}
			const { routine } = await createRoutine(scope.userId, {
				botId: scope.botId,
				...(await groupFields()),
				...pageFields(),
				name: title,
				prompt: detail,
				triggerType: "cron",
				schedule: scheduleRaw || null,
				enabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
				...alertCreateFields(),
			});
			await ctx.onRoutineMutated?.(routine).catch(() => undefined);
			const routineEvent = await emitRoutineCard(ctx, {
				type: "routine",
				action: "created",
				routineId: routine.id,
				title: routine.name,
				triggerType: "cron",
				detail: routineDetailText(routine),
			});
			return {
				summary: routine.alert
					? `Alerta "${routine.name}" criado (${describeRoutineAlertSentence(routine)}). Card emitido só nesta criação. Responda em texto, em uma frase: o que você vai vigiar e com que frequência.${alertSummaryTail}`
					: `Rotina cron "${routine.name}" criada (${routine.schedule ?? "sem schedule"}). Card emitido só nesta criação. Responda em texto.`,
				routineEvent,
			};
		}
		if (action === "create" && triggerType === "interval") {
			const ruleEvery = ruleEveryMinutes();
			const parsedEvery = ruleEvery !== undefined ? { ok: true as const, everyMinutes: ruleEvery } : parseIntervalEveryMinutes({ everyMinutes: args.every_minutes });
			if (!parsedEvery.ok) throw new Error(parsedEvery.error);
			if (alertInput && !alertInput.rule) assertAlertIntervalAllowed(parsedEvery.everyMinutes, args.alert);
			const { routine } = await createRoutine(scope.userId, {
				botId: scope.botId,
				...(await groupFields()),
				...pageFields(),
				name: title,
				prompt: detail,
				triggerType: "interval",
				trigger: { kind: "interval", everyMinutes: parsedEvery.everyMinutes },
				enabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
				...alertCreateFields(),
			});
			await ctx.onRoutineMutated?.(routine).catch(() => undefined);
			const routineEvent = await emitRoutineCard(ctx, {
				type: "routine",
				action: "created",
				routineId: routine.id,
				title: routine.name,
				triggerType: "interval",
				detail: routineDetailText(routine),
			});
			return {
				summary: routine.alert
					? `Alerta "${routine.name}" criado (${describeRoutineAlertSentence(routine)}). Card emitido só nesta criação. Responda em texto, em uma frase: o que você vai vigiar e com que frequência.${alertSummaryTail}`
					: `Rotina "${routine.name}" criada (${formatIntervalSummary(parsedEvery.everyMinutes)}). Card emitido só nesta criação. Responda em texto.`,
				routineEvent,
			};
		}
		if (action === "create" && triggerType === "once") {
			const parsedRunAt = resolveOnceRunAt({ runAt: args.run_at, inMinutes: args.in_minutes, timezone });
			if (!parsedRunAt.ok) {
				return { summary: `Não criei o lembrete: ${parsedRunAt.error}` };
			}
			const { routine } = await createRoutine(scope.userId, {
				botId: scope.botId,
				...(await groupFields()),
				...pageFields(),
				name: title,
				prompt: detail,
				triggerType: "once",
				trigger: { kind: "once", runAt: parsedRunAt.runAtIso },
				enabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
			});
			await ctx.onRoutineMutated?.(routine).catch(() => undefined);
			const routineEvent = await emitRoutineCard(ctx, {
				type: "routine",
				action: "created",
				routineId: routine.id,
				title: routine.name,
				triggerType: "once",
				detail: routineDetailText(routine),
			});
			return {
				summary: `Lembrete "${routine.name}" criado (${formatOnceSummary(parsedRunAt.runAtIso, timezone)}). Dispara uma vez e se apaga sozinho. Card emitido só nesta criação. Responda em texto.`,
				routineEvent,
			};
		}
		if (action === "create" && triggerType === "email") {
			const parsed = parseEmailTriggerInput(args.email);
			if ("error" in parsed) return { summary: `Não criei a rotina: ${parsed.error}` };
			const { routine } = await createRoutine(scope.userId, {
				botId: scope.botId,
				...(await groupFields()),
				...pageFields(),
				name: title,
				prompt: detail,
				triggerType: "event",
				trigger: { kind: "email", ...parsed.value },
				enabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
			}).catch((error: unknown) => {
				throw new Error(emailTriggerErrorWithHint(error));
			});
			await ctx.onRoutineMutated?.(routine).catch(() => undefined);
			const routineEvent = await emitRoutineCard(ctx, {
				type: "routine",
				action: "created",
				routineId: routine.id,
				title: routine.name,
				triggerType: "event",
				detail: routineDetailText(routine),
			});
			return {
				summary: `Rotina "${routine.name}" criada: ${describeEmailTrigger(parsed.value)}. Só remetentes permitidos da caixa do bot disparam. Card emitido só nesta criação. Responda em texto.`,
				routineEvent,
			};
		}
		if (action === "create" && triggerType === "github") {
			const parsed = parseGithubTriggerInput(mapGithubToolArgs(args.github));
			if ("error" in parsed) {
				return { summary: `Não criei a rotina: ${parsed.error}` };
			}
			const githubTrigger = parsed.value;
			const { routine } = await createRoutine(scope.userId, {
				botId: scope.botId,
				...(await groupFields()),
				...pageFields(),
				name: title,
				prompt: detail,
				triggerType: "event",
				trigger: { kind: "github", ...githubTrigger },
				enabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
			});
			await ctx.onRoutineMutated?.(routine).catch(() => undefined);
			const hookResult = await ensureGithubRepoHook({
				userId: scope.userId,
				repo: githubTrigger.repo,
			});
			if ("error" in hookResult) {
				await deleteRoutine(scope.userId, scope.botId, routine.id).catch(() => undefined);
				return {
					summary: `Não consegui ativar o gatilho do GitHub: ${hookResult.error}. Informe o usuário; NÃO tente criar o webhook do GitHub por conta própria (Composio ou outras ferramentas) — o Atlas só aceita entregas assinadas com o segredo interno.`,
				};
			}
			const description = describeGithubTrigger(githubTrigger);
			const routineEvent = await emitRoutineCard(ctx, {
				type: "routine",
				action: "created",
				routineId: routine.id,
				title: routine.name,
				triggerType: "event",
				detail: [description, "", routine.prompt].join("\n"),
			});
			return {
				summary: `Rotina GitHub "${routine.name}" criada: ${description}. O webhook do repositório foi criado e é gerenciado automaticamente pelo Atlas; NÃO crie nem altere webhooks do GitHub por conta própria (Composio ou outras ferramentas). Card emitido só nesta criação. Responda em texto.`,
				routineEvent,
			};
		}
		if (action === "create") {
			const { routine, hookSecret } = await createRoutine(scope.userId, {
				botId: scope.botId,
				...(await groupFields()),
				...pageFields(),
				name: title,
				prompt: detail,
				triggerType: "event",
				trigger: { kind: "generic" },
				enabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
			});
			await ctx.onRoutineMutated?.(routine).catch(() => undefined);
			const hookUrl =
				routine.hook?.url ??
				(routine.hook?.hookKey ? hookPublicUrl(routine.hook.hookKey) : undefined);
			const routineEvent = await emitRoutineCard(ctx, {
				type: "routine",
				action: "created",
				routineId: routine.id,
				title: routine.name,
				triggerType: "event",
				detail: routineDetailText(routine, hookSecret),
				...(hookUrl ? { hookUrl } : {}),
				...(hookSecret ? { hookSecret } : {}),
			});
			return {
				summary: `Rotina webhook "${routine.name}" criada. Card emitido só nesta criação. Diga para guardar o secret. Não invente URL.`,
				routineEvent,
			};
		}
	}

	const target = String(args.target ?? "").trim();
	if (!target && !existingOnCreate) throw new Error("para edit, informe target (nome ou id da rotina)");
	const resolved = existingOnCreate
		? { kind: "one" as const, routine: existingOnCreate }
		: await resolveRoutineTarget(scope, target);
	if (resolved.kind === "none") {
		return {
			summary: `Não achei rotina parecida com "${target.slice(0, 80)}". Use list_routines.`,
		};
	}
	if (resolved.kind === "ambiguous") {
		return {
			summary: `Achei mais de uma rotina:\n${resolved.lines}\nPeça ao usuário qual.`,
		};
	}
	const previous = resolved.routine;
	if (previous.template === DAILY_BRIEF_TEMPLATE) {
		// "Seu dia" é uma execução por dia, só em cron, e sempre avisa (o run do brief não tem notify_user).
		if (triggerType !== "cron") {
			throw new Error('"Seu dia" roda uma vez por dia em horário fixo: mantenha trigger_type cron (mude só horário, dias ou pausa).');
		}
		if (scheduleRaw) {
			const parsedBrief = parseDailyBriefSchedule(scheduleRaw);
			if (!parsedBrief.ok) throw new Error(parsedBrief.error);
		}
		notify = "always";
	}
	// Edit preserva o enabled/disabled atual quando o argumento não veio —
	// nunca reativa uma rotina pausada só por editar outra coisa (prompt,
	// gatilho, etc).
	const nextEnabled = enabledArg ?? previous.enabled;
	const nextName = String(args.title ?? "").trim().slice(0, 120) || undefined;
	if (args.group !== undefined) {
		// String vazia tira do grupo; nome reaproveita/cria.
		const groupId = groupName ? (await findOrCreateRoutineGroup(scope.userId, scope.botId, groupName)).group.id : null;
		await updateRoutine(scope.userId, scope.botId, previous.id, { groupId });
	}
	if (pageIdRaw !== undefined) {
		// String vazia desliga; id válido liga (a página já foi conferida acima).
		await updateRoutine(scope.userId, scope.botId, previous.id, { pageId: pageIdRaw || null });
	}

	if (triggerType === "once") {
		let runAtIso: string;
		if (args.run_at !== undefined || args.in_minutes !== undefined) {
			const parsedRunAt = resolveOnceRunAt({ runAt: args.run_at, inMinutes: args.in_minutes, timezone });
			if (!parsedRunAt.ok) {
				return { summary: `Não editei o lembrete: ${parsedRunAt.error}` };
			}
			runAtIso = parsedRunAt.runAtIso;
		} else if (previous.once?.runAt) {
			runAtIso = previous.once.runAt;
		} else {
			return {
				summary: "Não editei o lembrete: informe run_at ou in_minutes ao trocar o gatilho pra 'uma vez'.",
			};
		}
		const updated = await updateRoutine(scope.userId, scope.botId, previous.id, {
			...(nextName ? { name: nextName } : {}),
			prompt: detail,
			triggerType: "once",
			schedule: null,
			enabled: nextEnabled,
			timezone,
			...(model ? { model } : {}),
			...(notify ? { notify } : {}),
			...alertEditFields(),
			onceTrigger: { runAt: runAtIso },
		});
		if (!updated) {
			return { summary: "Não consegui atualizar a rotina agora." };
		}
		if (previous.github) {
			// Saiu de github pra "uma vez": a rotina não conta mais na união de
			// eventos do repo antigo — encolhe (ou apaga) o hook de lá.
			await ensureGithubRepoHook({ userId: scope.userId, repo: previous.github.repo }).catch(
				() => undefined,
			);
		}
		await ctx.onRoutineMutated?.(updated).catch(() => undefined);
		return {
			summary: `Rotina "${updated.name}" atualizada (sem card): ${formatOnceSummary(runAtIso, timezone)}.`,
			routineEvent: routineUpdatedEvent(updated),
		};
	}

	if (triggerType === "interval") {
		let everyMinutes: number;
		const ruleEvery = args.every_minutes !== undefined || alertInput?.rule?.intervalMinutes !== undefined ? ruleEveryMinutes() : undefined;
		if (ruleEvery !== undefined) {
			everyMinutes = ruleEvery;
		} else if (args.every_minutes !== undefined) {
			const parsedEvery = parseIntervalEveryMinutes({ everyMinutes: args.every_minutes });
			if (!parsedEvery.ok) throw new Error(parsedEvery.error);
			const modelChecked = alertInput ? !alertInput.rule : alertInput === undefined && previous.alert && !previous.alert.rule;
			if (modelChecked) assertAlertIntervalAllowed(parsedEvery.everyMinutes, args.alert);
			everyMinutes = parsedEvery.everyMinutes;
		} else if (previous.interval?.everyMinutes) {
			everyMinutes = previous.interval.everyMinutes;
		} else {
			throw new Error("informe every_minutes ao trocar o gatilho pra intervalo");
		}
		const updated = await updateRoutine(scope.userId, scope.botId, previous.id, {
			...(nextName ? { name: nextName } : {}),
			prompt: detail,
			triggerType: "interval",
			schedule: null,
			enabled: nextEnabled,
			timezone,
			...(model ? { model } : {}),
			...(notify ? { notify } : {}),
			...alertEditFields(),
			intervalTrigger: { everyMinutes },
		});
		if (!updated) {
			return { summary: "Não consegui atualizar a rotina agora." };
		}
		if (previous.github) {
			// Saiu de github pra intervalo: encolhe (ou apaga) o hook do repo antigo.
			await ensureGithubRepoHook({ userId: scope.userId, repo: previous.github.repo }).catch(
				() => undefined,
			);
		}
		await ctx.onRoutineMutated?.(updated).catch(() => undefined);
		return {
			summary: updated.alert
				? `Alerta "${updated.name}" atualizado (sem card): ${describeRoutineAlertSentence(updated)}.${alertSummaryTail}`
				: `Rotina "${updated.name}" atualizada (sem card): ${formatIntervalSummary(everyMinutes)}.`,
			routineEvent: routineUpdatedEvent(updated),
		};
	}

	if (triggerType === "email") {
		const patchRaw = (args.email && typeof args.email === "object" ? args.email : {}) as Record<string, unknown>;
		const patch: { fromContains?: string | null; subjectContains?: string | null } = {};
		for (const [argKey, key] of [["from_contains", "fromContains"], ["subject_contains", "subjectContains"]] as const) {
			if (patchRaw[argKey] === undefined) continue;
			const checked = parseEmailTriggerInput({ [argKey]: patchRaw[argKey] });
			if ("error" in checked) return { summary: `Não editei o gatilho de e-mail: ${checked.error}` };
			patch[key] = checked.value[key] ?? null;
		}
		const updated = await updateRoutine(scope.userId, scope.botId, previous.id, {
			...(nextName ? { name: nextName } : {}),
			prompt: detail,
			triggerType: "event",
			schedule: null,
			enabled: nextEnabled,
			timezone,
			...(model ? { model } : {}),
			...(notify ? { notify } : {}),
			...alertEditFields(),
			emailTrigger: patch,
		}).catch((error: unknown) => {
			throw new Error(emailTriggerErrorWithHint(error));
		});
		if (!updated) {
			return { summary: "Não consegui atualizar a rotina agora." };
		}
		if (previous.github) {
			await ensureGithubRepoHook({ userId: scope.userId, repo: previous.github.repo }).catch(() => undefined);
		}
		await ctx.onRoutineMutated?.(updated).catch(() => undefined);
		return {
			summary: `Rotina "${updated.name}" atualizada (sem card): ${describeEmailTrigger(updated.email ?? {})}.`,
			routineEvent: routineUpdatedEvent(updated),
		};
	}

	if (triggerType === "github") {
		const patchRaw = (
			args.github && typeof args.github === "object" ? args.github : {}
		) as Record<string, unknown>;
		// Sem trigger github atual pra herdar campos (rotina era cron/event
		// genérico) — o patch precisa vir completo (repo+events);
		// `parseGithubTriggerInput` recusa se faltar.
		const merged = {
			repo: patchRaw.repo !== undefined ? patchRaw.repo : previous.github?.repo,
			events: patchRaw.events !== undefined ? patchRaw.events : previous.github?.events,
			prNumber:
				patchRaw.pr_number !== undefined ? patchRaw.pr_number : previous.github?.prNumber,
			users: patchRaw.users !== undefined ? patchRaw.users : previous.github?.users,
			branch:
				patchRaw.branch !== undefined
					? patchRaw.branch
					: patchRaw.ci_branch !== undefined
						? patchRaw.ci_branch
						: previous.github?.branch,
		};
		const parsed = parseGithubTriggerInput(merged);
		if ("error" in parsed) {
			return { summary: `Não editei o gatilho do GitHub: ${parsed.error}` };
		}
		const nextGithub = parsed.value;
		const updated = await updateRoutine(scope.userId, scope.botId, previous.id, {
			...(nextName ? { name: nextName } : {}),
			prompt: detail,
			triggerType: "event",
			schedule: null,
			enabled: nextEnabled,
			timezone,
			...(model ? { model } : {}),
			...(notify ? { notify } : {}),
			...alertEditFields(),
			githubTrigger: {
				repo: nextGithub.repo,
				events: nextGithub.events,
				prNumber: nextGithub.prNumber ?? null,
				users: nextGithub.users ?? null,
				branch: nextGithub.branch ?? null,
			},
		});
		if (!updated) {
			return { summary: "Não consegui atualizar a rotina agora." };
		}
		const hookResult = await ensureGithubRepoHook({
			userId: scope.userId,
			repo: nextGithub.repo,
		});
		if ("error" in hookResult) {
			// Mantém o gatilho anterior: a rotina não pode ficar apontando pra um
			// webhook que não existe/não sincronizou. Reverte o que dá pra
			// reverter (github/cron); webhook genérico anterior não tem como
			// restaurar por aqui (a API nunca expõe o secret cru de novo).
			let reverted: RoutineRecord | null = null;
			if (previous.github) {
				reverted = await updateRoutine(scope.userId, scope.botId, previous.id, {
					triggerType: "event",
					schedule: null,
					githubTrigger: {
						repo: previous.github.repo,
						events: previous.github.events,
						prNumber: previous.github.prNumber ?? null,
						users: previous.github.users ?? null,
						branch: previous.github.branch ?? null,
					},
				}).catch(() => null);
			} else if (previous.triggerType === "cron") {
				reverted = await updateRoutine(scope.userId, scope.botId, previous.id, {
					triggerType: "cron",
					schedule: previous.schedule,
					triggerJson: previous.triggerJson,
				}).catch(() => null);
			}
			if (reverted) await ctx.onRoutineMutated?.(reverted).catch(() => undefined);
			const restoreNote =
				!previous.github && previous.triggerType === "event"
					? " O webhook genérico anterior não pôde ser restaurado automaticamente (o secret não fica disponível aqui) — confira a rotina."
					: "";
			return { summary: `Não consegui ativar o gatilho do GitHub: ${hookResult.error}${restoreNote}` };
		}
		if (previous.github && previous.github.repo.toLowerCase() !== nextGithub.repo.toLowerCase()) {
			// Repo mudou: a rotina não assina mais o repo antigo — encolhe o hook
			// de lá também (best-effort).
			await ensureGithubRepoHook({ userId: scope.userId, repo: previous.github.repo }).catch(
				() => undefined,
			);
		}
		await ctx.onRoutineMutated?.(updated).catch(() => undefined);
		return {
			summary: `Rotina "${updated.name}" atualizada (sem card): ${describeGithubTrigger(nextGithub)}.`,
			routineEvent: routineUpdatedEvent(updated),
		};
	}

	const wasGithub = Boolean(previous.github);
	if (triggerType === "event" && (wasGithub || previous.triggerType !== "event")) {
		const converted = await convertRoutineToGenericWebhook(
			scope.userId,
			scope.botId,
			previous.id,
			{
				...(nextName ? { name: nextName } : {}),
				prompt: detail,
				enabled: nextEnabled,
				timezone,
				...(model ? { model } : {}),
				...(notify ? { notify } : {}),
			},
		);
		if (!converted) return { summary: "Não consegui atualizar a rotina agora." };
		if (previous.github) {
			await ensureGithubRepoHook({ userId: scope.userId, repo: previous.github.repo }).catch(
				() => undefined,
			);
		}
		await ctx.onRoutineMutated?.(converted.routine).catch(() => undefined);
		const detailText = routineDetailText(converted.routine, converted.hookSecret);
		return {
			summary: `Rotina "${converted.routine.name}" atualizada como webhook genérico. Informe ao usuário a URL e o secret abaixo agora; o secret não poderá ser consultado novamente.\n${detailText}`,
			routineEvent: routineUpdatedEvent(converted.routine),
		};
	}
	if (triggerType === "cron" && scheduleRaw && !isCronFive(scheduleRaw)) {
		throw new Error(
			`schedule inválido "${scheduleRaw}" — use 5 campos cron (ex.: 0 9 * * *)`,
		);
	}
	if (triggerType === "cron" && nextEnabled && !scheduleRaw && !previous.schedule) {
		throw new Error("cron ativo exige schedule (5 campos, ex.: 0 9 * * *)");
	}
	const updated = await updateRoutine(
		scope.userId,
		scope.botId,
		previous.id,
		{
			...(nextName ? { name: nextName } : {}),
			prompt: detail,
			triggerType,
			...(triggerType === "cron"
				? { schedule: scheduleRaw || previous.schedule }
				: { schedule: null }),
			enabled: nextEnabled,
			timezone,
			...(model ? { model } : {}),
			...(notify ? { notify } : {}),
			...alertEditFields(),
		},
	);
	if (!updated) {
		return { summary: "Não consegui atualizar a rotina agora." };
	}
	if (wasGithub && previous.github) {
		// Saiu de github pra cron/event genérico: a rotina não conta mais na
		// união de eventos do repo antigo — encolhe (ou apaga) o hook de lá.
		await ensureGithubRepoHook({ userId: scope.userId, repo: previous.github.repo }).catch(
			() => undefined,
		);
	}
	await ctx.onRoutineMutated?.(updated).catch(() => undefined);
	return {
		summary: updated.alert
			? `Alerta "${updated.name}" atualizado (sem card): ${describeRoutineAlertSentence(updated)}. Responda em texto.${alertSummaryTail}`
			: `Rotina "${updated.name}" atualizada (sem card). Responda em texto.`,
		routineEvent: routineUpdatedEvent(updated),
	};
}
