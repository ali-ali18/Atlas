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
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { ROUTINE_CONTROL_TOOL } from "../../routine-control.js";
import { GITHUB_TRIGGER_EVENTS } from "@workspace/shared";
import { ALERT_RULE_SCHEMA } from "../../alert-rule.js";
import { REPORT_ALERT_TOOL } from "../../report-alert.js";
import { FIND_PAGE_VALUE_TOOL } from "../../find-page-value.js";

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

/** Família `routines`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const ROUTINES_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "list_routines",
		definition: {
				type: "function",
				function: {
					name: "list_routines",
					description:
						"Lista as rotinas deste bot em texto (sem card), com os alertas por condição (condição, frequência, se está avisando agora) e o modo de aviso. Use para consultar rotinas e alertas existentes, e antes de pausar, retomar, apagar ou editar uma. Não invente rotinas.",
					parameters: {
						type: "object",
						properties: {
							only_enabled: {
								type: "boolean",
								description: "Lista só ativas (padrão false = todas).",
							},
							only_alerts: {
								type: "boolean",
								description: "Lista só alertas por condição (\"quais alertas eu tenho?\"). Padrão false = todas.",
							},
						},
					},
				},
			},
		effect: "read",
		group: "routines",
		run: handleListRoutines,
	}),
	defineRawTool({
		name: "routine_group",
		definition: {
				type: "function",
				function: {
					name: "routine_group",
					description:
						"Pausa, retoma, renomeia ou desfaz um grupo de uma vez (o mesmo grupo reúne rotinas e painéis). delete só remove o grupo: rotinas e painéis continuam, sem grupo. group = nome ou id do grupo (aparece em list_routines e page_list). rename exige new_name. Para criar um grupo ou mover um painel, use o campo group de page_create/page_update.",
					parameters: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["pause", "resume", "rename", "delete"],
								description: "pause = pausa todas; resume = ativa todas; rename = muda o nome (new_name); delete = desfaz o grupo mantendo as rotinas.",
							},
							new_name: { type: "string", description: "Novo nome do grupo (só em rename, até 80 caracteres)." },
							group: {
								type: "string",
								description: "Nome ou id do grupo.",
							},
						},
						required: ["action", "group"],
					},
				},
			},
		effect: "write_external",
		group: "routines",
		run: handleRoutineGroup,
	}),
	defineRawTool({
		name: "routine_control",
		definition: ROUTINE_CONTROL_TOOL,
		effect: "write_internal",
		group: "routines",
		run: handleRoutineControl,
	}),
	defineRawTool({
		name: "propose_routine",
		definition: {
				type: "function",
				function: {
					name: "propose_routine",
					description:
						"Create (action create) or edit (action edit) a routine. Card only on create. Create: title=name, detail=prompt to run on each trigger, trigger_type cron|interval|once|event|github. cron: needs schedule (5 fields), fixed clock times. interval: needs every_minutes (5-1440), exact \"every N minutes/hours\" counted from the last run (use for \"every 50 min\", including GitHub monitoring). once (\"remind me on 03/10 at 10h\"): needs run_at (ISO 8601; no offset = America/Sao_Paulo) for a clock time, or in_minutes for \"in N minutes/hours\" (the server adds it to the current time); never both; fires once and deletes itself; several times = one call per time. event: generic webhook (URL+secret). email: runs when an e-mail arrives in the bot's own inbox (\"toda vez que chegar e-mail de X\", \"quando o fornecedor mandar a NF\"); optional `email` filters from_contains / subject_contains; needs the bot's mailbox to be active (email_create_mailbox) and only allowed senders trigger it; the e-mail text reaches the run as untrusted data, and the e-mail is handled by the routine instead of a normal chat reply; the routine only replies or sends e-mail if `detail` explicitly says so. github: instant webhook, needs the `github` object (repo, events; use github_list_repos if the repo is not owner/name). The github trigger creates and manages the repository webhook AUTOMATICALLY (URL and secret are internal, using the user's GitHub from the Marketplace or Composio). NEVER create, edit or delete GitHub webhooks yourself via Composio or any other tool (e.g. GITHUB_CREATE_A_REPOSITORY_WEBHOOK): deliveries signed with any other secret are rejected. Never show secret or URL to assemble by hand. Webhook and interval can coexist for the same repo as two routines. Security review of a GitHub repo: set template=github_security_review and repo=owner/name (detail may be empty or hold an extra focus); combine with interval for periodic reviews. Morning brief (\"me prepara o dia às 7h30\", \"quero um resumo do meu dia toda manhã\"): set template=daily_brief (trigger_type cron; schedule only if the user gave a time/days, as a 5-field cron with ONE fixed time per day, e.g. \"30 7 * * 1-5\"; omit it for the default 07:30 Monday to Friday). It sends a short message in the chat (plus a push) at that time, no panel, only one per bot (asking again edits it), read-only on the user's sources, only the connected ones (state exactly the sources the tool result lists; never promise a portal, site or app that is not a connected source); detail is optional extra focus (\"não olhe o Slack\"). Change its time/days or pause it with action=edit target=\"Seu dia\". Edit: target=name or id (use the id if the message has '(id ...)'; never confuse with editing the bot profile); no card; trigger_type may change (switching to github needs repo+events, to once needs run_at, to interval needs every_minutes); enabled omitted keeps the current state. Use only when the user's latest message asks to schedule, monitor or change a recurring or timed job. Do not use when the user only thanks, praises or acknowledges (answer in one sentence instead), inside a routine run, or for a one-off task to do now. If a routine with the same name exists, edit instead of duplicating. Alert by condition (\"avisa se o estoque do produto X cair abaixo de 10\", \"se a venda do dia ficar abaixo da meta às 17h\", \"se chegar pedido acima de R$ 5 mil\"): create a routine with trigger_type interval (every N minutes) or cron (fixed times) plus the alert object. Each run only checks the condition with read tools and the user is notified only when it newly becomes true, so do not ask for a notification schedule. detail = how to check it (which connector/tool, product, field, threshold, and the date range: \"today\" for daily totals); alert.condition = the user's condition as a short phrase in their language that completes \"avisa se ...\"; alert.hint = optional pointer on where to look. Each check costs a model run, so pick few, well-placed check times instead of a short interval: business data only changes in business hours, so use trigger_type cron on weekdays (stock: a few times a day, e.g. \"0 10,14,17 * * 1-5\"; end-of-day target such as \"venda do dia abaixo da meta\": one check near the moment it matters, e.g. \"0 17 * * 1-5\"; new orders: every 2-4 hours in business hours, e.g. \"0 9-18/3 * * 1-5\"). An interval alert (every_minutes) must be at least 120 minutes unless the user explicitly asked for a more frequent check (then pass alert.frequent=true); the server widens a quiet alert's interval by itself. Never pick every 30 minutes on your own. Tell the user in one sentence what you will watch and when. Alert with `alert.rule` (exact value or new item on a public page or feed, no model cost): you choose the frequency (alert.rule.intervalMinutes, or every_minutes for interval) and the 120-minute minimum above does not apply; the rule is tested live on creation and the tool fails if it cannot read it. Only with trigger_type cron or interval; not for one-off reminders (use once) or instant events (use github/event). Edit: pass alert to change the condition, or alert.condition empty to turn it back into a normal routine. To keep a page up to date, pass page_id (from page_create or page_list) and write in detail how to rebuild it with fresh data (which sources to query, which sections to refresh); each run then updates that page in place instead of posting a new message.",
					parameters: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["create", "edit"],
								description: "Criar nova ou editar existente.",
							},
							title: {
								type: "string",
								description: "Nome curto da rotina (create) ou novo nome (edit).",
							},
							target: {
								type: "string",
								description:
									"Para edit: nome OU id da rotina alvo. Se a mensagem do usuário trouxer '(id XYZ)' (prefill do botão Editar), use XYZ — não o nome.",
							},
							detail: {
								type: "string",
								description: "Prompt/instrução que o agente segue ao disparar.",
							},
							trigger_type: {
								type: "string",
								enum: ["cron", "once", "interval", "event", "github", "email"],
								description: "email = quando chegar e-mail na caixa do bot (filtros opcionais em `email`); cron = agenda repetida; interval = a cada N minutos exatos (usa every_minutes); once = dispara uma vez só num horário e se apaga (usa run_at); event = webhook genérico; github = gatilho do GitHub (webhook instantâneo; para \"a cada N min\" use interval). Em edit, pode ser diferente do tipo atual da rotina — troca o gatilho.",
							},
							schedule: {
								type: "string",
								description: "Expressão cron de 5 campos (obrigatório se cron e enabled).",
							},
							run_at: {
								type: "string",
								description:
									"Para trigger_type=once (create, ou edit trocando PRA once), use run_at OU in_minutes. Data/hora ISO 8601 do disparo único, ex.: 2026-10-03T10:00. Sem offset/'Z', interpreta no fuso de `timezone` (padrão America/Sao_Paulo). Precisa ser no futuro e no máximo 1 ano à frente. Um único horário por chamada — vários horários = várias chamadas.",
							},
							in_minutes: {
								type: "integer",
								minimum: 1,
								maximum: 10080,
								description:
									"Alternative to run_at for trigger_type=once: fire N minutes from now (1-10080). Use for \"in 30 minutes\" / \"in 2 hours\" (120); use run_at for a clock time. Never both.",
							},
							every_minutes: {
								type: "number",
								description:
									"Obrigatório se trigger_type=interval (create, ou edit trocando PRA interval). Inteiro de 5 a 1440 (ex.: 50 = a cada 50 minutos; 120 = a cada 2 h).",
							},
							template: {
								type: "string",
								enum: [GITHUB_SECURITY_REVIEW_TEMPLATE, DAILY_BRIEF_TEMPLATE],
								description:
									"Optional prompt template. github_security_review = periodic security review of a GitHub repo with a 0-10 score; requires repo. Replaces detail (detail becomes an optional extra focus). daily_brief = the morning brief \"Seu dia\" (agenda, e-mails that need the user, priorities) delivered as a chat message and a push, no panel; detail is optional extra focus.",
							},
							repo: {
								type: "string",
								description: "owner/name of the repository (only with template=github_security_review).",
							},
							timezone: {
								type: "string",
								description: "Fuso IANA (padrão America/Sao_Paulo). Também usado pra interpretar run_at (once) sem offset.",
							},
							enabled: {
								type: "boolean",
								description:
									"Se a rotina fica ativa. Create: padrão true. Edit: omita pra manter o estado atual (ativa/pausada) — só informe quando o usuário pedir pra ativar/retomar/pausar.",
							},
							model: {
								type: "string",
								description: "Modelo OpenRouter opcional para esta rotina.",
							},
							notify: {
								type: "string",
								enum: ["always", "important"],
								description:
									"Aviso (push) ao fim de cada execução. always (padrão) = sempre avisa. important = a execução fica salva no chat sem aviso, e quem executa só avisa quando o resultado merece atenção agora. Use important para monitoramentos em que a maioria das execuções não traz nada novo. Em edit, omita para manter.",
							},
							alert: {
								type: "object",
								description:
									"Turns the routine into an alert by condition (only trigger_type cron or interval): the routine checks on its schedule and the user is notified only when the condition becomes true (and again only after it stopped being true). `condition` is required unless `rule` is given (then it is generated from the rule). In edit, an empty condition removes the alert; omit to keep.",
								properties: {
									condition: {
										type: "string",
										description: "The condition as a short phrase in the user's language that completes \"avisa se ...\", e.g. \"o estoque da canela cair abaixo de 10\", \"a venda do dia ficar abaixo da meta\", \"chegar pedido acima de R$ 5 mil\".",
									},
									frequent: {
										type: "boolean",
										description: "true ONLY when the user explicitly asked for checks more often than every 2 hours (e.g. \"confere a cada 10 minutos\"). Never set it on your own.",
									},
									hint: {
										type: "string",
										description: "Optional pointer for the checker: connector/tool to use, product, field, threshold, date range.",
									},
									rule: ALERT_RULE_SCHEMA,
								},
							},
							page_id: {
								type: "string",
								description:
									"Id of a page of this bot (from page_create or page_list) that each run refreshes in place via page_update. Omit unless the user wants a page kept up to date. In edit, an empty string detaches the page; omit to keep.",
							},
							group: {
								type: "string",
								description:
									"Nome do grupo da rotina. Rotinas da mesma tarefa usam o mesmo nome (curto e descritivo); um grupo com esse nome é reaproveitado, senão é criado. Em edit, string vazia tira a rotina do grupo; omita para manter.",
							},
							email: {
								type: "object",
								description:
									"Only with trigger_type=email. Both filters are optional, case-insensitive \"contains\" matches; omit both for every e-mail from an allowed sender. In edit of an email routine, only the fields that change (empty string removes a filter).",
								properties: {
									from_contains: { type: "string", description: "Part of the sender address or domain, e.g. \"fornecedor@\" or \"@fornecedor.com\"." },
									subject_contains: { type: "string", description: "Part of the subject, e.g. \"NF\"." },
								},
							},
							github: {
								type: "object",
								description:
									"Obrigatório (ao menos repo+events) quando trigger_type=github no create OU ao trocar de cron/event pra github no edit; em edit de uma rotina já github, só os campos que mudaram.",
								properties: {
									repo: {
										type: "string",
										description: "owner/name do repositório (aceita colar a URL do GitHub).",
									},
									events: {
										type: "array",
										items: { type: "string", enum: [...GITHUB_TRIGGER_EVENTS] },
										description:
											"Eventos do GitHub a observar. Para 'fica de olho no PR N' use o conjunto completo de babá de PR. Para 'acompanhar/toda mudança na branch X' use [push, pr_opened, pr_merged] + branch=X.",
									},
									pr_number: {
										type: "number",
										description: "Restringe a um PR específico (babá de PR: a rotina se apaga quando o PR fechar).",
									},
									users: {
										type: "array",
										items: { type: "string" },
										description: "Filtro de autor/ator (login, com ou sem @); eventos ci_* são isentos.",
									},
									branch: {
										type: "string",
										description:
											"Filtro de branch (sem pr_number): ci_* = branch do check suite (obrigatório se algum evento ci_* estiver selecionado); push = branch do push; pr_* = branch BASE/destino do PR. Aceita também `ci_branch` (alias antigo, mesmo campo).",
									},
									ci_branch: {
										type: "string",
										description: "Alias antigo de `branch` — mesmo campo, mantido por compatibilidade.",
									},
								},
							},
						},
						required: ["action", "detail", "trigger_type"],
					},
				},
			},
		effect: "write_external",
		ownCard: true,
		group: "routines",
		run: handleProposeRoutine,
	}),
	defineRawTool({
		name: "report_alert",
		definition: REPORT_ALERT_TOOL,
		effect: "write_internal",
		endsTurn: true,
		group: "routines",
		run: handleReportAlert,
	}),
	defineRawTool({
		name: "find_page_value",
		definition: FIND_PAGE_VALUE_TOOL,
		effect: "read",
		group: "routines",
		run: handleFindPageValue,
	}),
];

export const ROUTINES_TOOLS: ToolFamily = definedFamily(ROUTINES_DEFINED);

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
