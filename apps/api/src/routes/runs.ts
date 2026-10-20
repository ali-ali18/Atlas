import { Hono } from "hono";
import { maskKnownSecretsInMessages, sealSecrets } from "@workspace/agent-runtime";
import { isActiveRunConflict, ResourceOwnershipError, type getAccountConfig } from "@workspace/db";
import { validateRunReferences } from "../chat/run-ownership.js";
import { API_INPUT_LIMITS, validMaxSteps } from "../chat/input-limits.js";
import { createRunObserver } from "./run-observer.js";
import {
	ATLAS_JOB_NAMES,
	parseModelRef,
	questionnaireAnswerInstruction,
	buildQuestionnaireAnsweredMessages,
	buildQuestionnaireAnsweredObjective,
	parseQuestionnaireAnswerBody,
	questionnaireAnswerClientKey,
	type ComputerUseEvent,
	type CreateAgentRunRequest,
	type CreateAgentRunResponse,
	type CreateRunInputRequest,
	parseRunInputMode,
} from "@workspace/shared";
import {
	appendRunEvent,
	createAgentRun,
	createRunInput,
	failAgentRunAfterRetries,
	getAgentRun,
	getAgentRunForUser,
	getAgentRunStreamState,
	getLatestCompletedRunForConversation,
	listQueuedRunsMissingJob,
	listQueuedRunsWithStaleJob,
	listRunsAwaitingConnector,
	listRunEventsAfter,
	listRunInputs,
	listRunsForConversation,
	markRunJobEnqueued,
	requestCancelAgentRun,
	requestPauseAgentRun,
	requestResumeAgentRun,
	submitQuestionnaireCard,
	parseImageAttachments,
	resolveUserFileCards,
	resolveUserImagesCard,
} from "@workspace/db";
import { demoteSteerInputToQueue, getOwnedConversation, markPendingLoginCode, markPendingLoginUseVault, promoteQueuedInputToSteer } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { publishRunSignal as defaultPublishRunSignal, subscribeRunEventsSignal, type AgentRunQueue } from "@workspace/queue";
import { runRunStream } from "./run-stream.js";
import { sseEncode } from "./sse-encode.js";
import { notifyRunSignal, type PublishRunSignal } from "../run-signal.js";
import type { RunQueue } from "./run-queue.js";
import type { ApiConfig } from "../config.js";
import { applyConfirmedFollowUp, maybeHandleConfirmedAction } from "../chat/confirmed-action.js";
import { buildJevIntentFor } from "../chat/jev-intent.js";
import { resolveGroupRunTarget } from "../chat/group-run.js";
import { peekModelContextLength } from "./models.js";
import { resolveRunModel, resolveRunModelChoice } from "../chat/effective-model.js";
import { createReactionOnlyDeps, maybeReactOnly, type ReactionOnlyDeps } from "../chat/reaction-only.js";
import { validateProviderModel } from "../providers/model-catalog.js";



/** Conversa ocupada por outro run no instante do envio (corrida com o fim dele). O cliente reenvia sem perder a mensagem. */
export const ACTIVE_RUN_CONFLICT_MESSAGE = "A conversa já tem uma tarefa em andamento. Tente de novo em instantes.";

const ALLOWED_ROLES = new Set(["user", "assistant", "system"]);

function parseCreateBody(
	json: unknown,
	idempotencyKeyHeader?: string,
): CreateAgentRunRequest | { error: string } {
	if (!json || typeof json !== "object") {
		return { error: "Invalid JSON body" };
	}
	const body = json as Record<string, unknown>;
	const attachments = parseImageAttachments(body.attachments);
	if (!attachments) return { error: "anexos inválidos" };
	if (!Array.isArray(body.messages) || body.messages.length > API_INPUT_LIMITS.messages) {
		return { error: "Invalid body: messages[] obrigatório" };
	}

	const messages: CreateAgentRunRequest["messages"] = [];
	for (const item of body.messages) {
		if (!item || typeof item !== "object") {
			return { error: "Mensagem inválida: esperado { role, content }" };
		}
		const role = (item as { role?: unknown }).role;
		const content = (item as { content?: unknown }).content;
		if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
			return { error: `Papel inválido: ${String(role)}` };
		}
		if (typeof content !== "string" || content.length > API_INPUT_LIMITS.contentChars) {
			return { error: "content deve ser string" };
		}
		messages.push({
			role: role as "user" | "assistant" | "system",
			content,
		});
	}
	if (messages.length === 0) {
		return { error: "messages não pode ser vazio" };
	}

	if (!validMaxSteps(body.maxSteps)) return { error: "maxSteps must be an integer from 1 to 100" };
	if (body.objective !== undefined && (typeof body.objective !== "string" || body.objective.length > API_INPUT_LIMITS.contentChars)) return { error: "Invalid objective" };
	return {
		messages,
		...(attachments.length ? { attachments } : {}),
		model: typeof body.model === "string" ? body.model : undefined,
		...(body.modelAuto === true ? { modelAuto: true } : {}),
		conversationId:
			typeof body.conversationId === "string" ? body.conversationId : undefined,
		botId: typeof body.botId === "string" ? body.botId : undefined,
		sandboxSessionId:
			typeof body.sandboxSessionId === "string"
				? body.sandboxSessionId
				: undefined,
		maxSteps:
			typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps)
				? body.maxSteps
				: undefined,
		origin:
			body.origin === "chat" ||
			body.origin === "routine" ||
			body.origin === "webhook"
				? body.origin
				: "chat",
		objective: typeof body.objective === "string" ? body.objective : undefined,
		decisionConfirmId: typeof body.decisionConfirmId === "string" && body.decisionConfirmId.trim() ? body.decisionConfirmId.trim().slice(0, 200) : undefined,
		budget: parseBudgetBody(body.budget),
		clientKey:
			typeof body.clientKey === "string" && body.clientKey.trim().length > 0
				? body.clientKey.trim().slice(0, 128)
				: typeof idempotencyKeyHeader === "string" &&
					  idempotencyKeyHeader.trim().length > 0
					? idempotencyKeyHeader.trim().slice(0, 128)
					: undefined,
		silent: body.silent === true,
		compact: body.compact === true,
	};
}

function positiveBudgetNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value;
}

/** Orçamento opcional do run; lixo é ignorado campo a campo, nunca 400. */
function parseBudgetBody(
	raw: unknown,
): CreateAgentRunRequest["budget"] | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const body = raw as Record<string, unknown>;
	const budget: NonNullable<CreateAgentRunRequest["budget"]> = {};
	const soft = positiveBudgetNumber(body.softMaxSteps);
	if (soft !== undefined) budget.softMaxSteps = Math.floor(soft);
	const hard = positiveBudgetNumber(body.hardMaxSteps);
	if (hard !== undefined) budget.hardMaxSteps = Math.floor(hard);
	const wall = positiveBudgetNumber(body.maxWallMs);
	if (wall !== undefined) budget.maxWallMs = Math.floor(wall);
	const tokens = positiveBudgetNumber(body.maxTokens);
	if (tokens !== undefined) budget.maxTokens = Math.floor(tokens);
	if (
		body.maxCallsPerTool &&
		typeof body.maxCallsPerTool === "object" &&
		!Array.isArray(body.maxCallsPerTool)
	) {
		const caps: Record<string, number> = {};
		for (const [name, cap] of Object.entries(
			body.maxCallsPerTool as Record<string, unknown>,
		)) {
			const parsed = positiveBudgetNumber(cap);
			if (parsed !== undefined) caps[name] = Math.floor(parsed);
		}
		if (Object.keys(caps).length > 0) budget.maxCallsPerTool = caps;
	}
	const ext = positiveBudgetNumber(body.extensionSteps);
	if (ext !== undefined) budget.extensionSteps = Math.floor(ext);
	return Object.keys(budget).length > 0 ? budget : undefined;
}

export function agentRunJobId(runId: string): string {
	return `agent-run-${runId}`;
}

export async function enqueueAgentRunJob(
	queue: RunQueue,
	runId: string,
): Promise<boolean> {
	try {
		// jobId determinístico: dois adds concorrentes colapsam num job só.
		// MAS job terminal retido (completed/failed) também bloqueia o re-add:
		// remove o artefato antes, senão resume/reconcile é ignorado em silêncio
		// e o run fica queued para sempre. Job vivo (waiting/active/delayed)
		// nunca é tocado.
		const jobId = agentRunJobId(runId);
		const existing = await queue.getJob(jobId).catch(() => null);
		if (existing) {
			const state = await existing
				.getState()
				.catch((): string | null => null);
			if (state === "completed" || state === "failed" || state === null) {
				await existing.remove().catch(() => undefined);
			} else {
				await markRunJobEnqueued(runId);
				return true;
			}
		}
		await queue.add(ATLAS_JOB_NAMES.runAgent, { runId }, { jobId });
		await markRunJobEnqueued(runId);
		return true;
	} catch (error) {
		console.error(`failed to enqueue agent run ${runId}`, error);
		return false;
	}
}

/**
 * Conexão do conector `catalogId` ficou ativa: retoma os runs do dono que
 * pausaram num card de conexão dele. Devolve os ids retomados.
 */
export async function resumeRunsAwaitingConnector(
	queue: RunQueue | null,
	userId: string,
	catalogId: string,
	kind: "native" | "api" = "native",
): Promise<string[]> {
	if (!queue) return [];
	const resumed: string[] = [];
	for (const runId of await listRunsAwaitingConnector(userId, catalogId, 20, kind)) {
		const run = await requestResumeAgentRun(runId).catch(() => null);
		if (run && (await enqueueAgentRunJob(queue, run.id))) resumed.push(run.id);
	}
	return resumed;
}

export async function reconcileQueuedAgentRuns(
	queue: AgentRunQueue | null,
): Promise<number> {
	if (!queue) return 0;
	let recovered = 0;
	// 1. Nunca enfileirados.
	const pending = await listQueuedRunsMissingJob(25);
	for (const row of pending) {
		const ok = await enqueueAgentRunJob(queue, row.id);
		if (ok) recovered += 1;
	}
	// 2. Marcados como enfileirados mas sem job vivo (perdido, ou artefato
	// terminal retido que o add ignoraria). Sem isso, o run fica queued
	// para sempre e a UI mostra "trabalhando" eternamente.
	const stale = await listQueuedRunsWithStaleJob(25);
	for (const row of stale) {
		const job = await queue.getJob(agentRunJobId(row.id)).catch(() => null);
		const state = job ? await job.getState().catch((): string | null => null) : null;
		if (state === null || state === "completed") {
			const ok = await enqueueAgentRunJob(queue, row.id);
			if (ok) recovered += 1;
		} else if (state === "failed") {
			// Veneno: não re-enfileira em loop; finaliza com diagnóstico.
			const finalized = await failAgentRunAfterRetries(
				row.id,
				"Job esgotou as tentativas sem finalizar o run.",
			).catch(() => false);
			if (finalized) recovered += 1;
		}
		// waiting/active/delayed: job vivo, nada a fazer.
	}
	return recovered;
}

export function createRunRoutes(
	config: Omit<ApiConfig, "agentRunQueue"> & { agentRunQueue: RunQueue | null },
	dependencies: {
		validateModel?: typeof validateProviderModel;
		getAccountConfig?: typeof getAccountConfig;
		/** Aviso ao worker (Redis pub/sub); injetável em teste. */
		publishRunSignal?: PublishRunSignal;
		/** Sinal de "run ganhou eventos" (Redis) para o stream SSE; injetável em teste. */
		subscribeRunEvents?: (runId: string, onEvents: () => void) => () => void;
		/** "Responder só com reação"; injetável em teste. */
		reactionOnly?: ReactionOnlyDeps;
	} = {},
) {
	const validateModel = dependencies.validateModel ?? validateProviderModel;
	const publish = dependencies.publishRunSignal ?? defaultPublishRunSignal;
	const subscribeEvents = dependencies.subscribeRunEvents ?? subscribeRunEventsSignal;
	const app = new Hono<AuthEnv>();
	async function validateRunModel(userId: string, model: string): Promise<{
		error: string; status: 400 | 404 | 409 | 503;
	} | null> {
		const result = await validateModel(userId, model);
		if ("status" in result) {
			return { error: result.error, status: result.status === 503 ? 409 : result.status };
		}
		// Exige catálogo confirmado antes de criar run ou consumir um card.
		if (result.warning) {
			return { error: `Catálogo ${parseModelRef(model).provider === "chatgpt" ? "ChatGPT" : "do provedor"} indisponível. Tente novamente antes de iniciar a tarefa.`, status: 409 };
		}
		if (parseModelRef(model).provider === "openrouter" && !config.openRouterApiKey) {
			return { error: "OPENROUTER_API_KEY is not configured on the API server", status: 503 };
		}
		return null;
	}

	/**
	 * POST /v1/runs — cria AgentRun (chat | routine | webhook).
	 *
	 * Evento `questionnaire-submitted` (ver `@workspace/shared/questionnaire`):
	 * contrato mínimo `{ botId, event: "questionnaire-submitted", answers:
	 * { direction, detail, briefing }, submittedAt }` entra como
	 * `messages[].user` em JSON, SEM texto estático pronto. `messages[0].system`
	 * = `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION` (per-evento; SYSTEM_PROMPT global
	 * intacto). O LLM consolida via tool `memory` (`target: "memory"`
	 * botId-escopado, category `bot_config`/`bot_evolution`, `importance>=0.7`,
	 * content `"<estado>. Porquê: <motivo>"`). `Bot.description` (estado atual,
	 * via confirm + `PATCH /v1/bots`) + memória (porquê) são lidos em runs
	 * futuros via `buildMemoryAugmentedMessages` + `renderRelevantMemoryPrompt`;
	 * nunca criar tabela `BotBriefing`. Idempotência: `clientKey`
	 * (`questionnaireClientKey`: `questionnaire-submitted:<botId>:<hash>`) ou
	 * header `Idempotency-Key`; colisão 1-run-ativo-por-conversa (P2002) vira
	 * steer no run ativo com dedup por `(runId, clientKey)` (ver
	 * `packages/db/src/runs.ts`). Exemplo curl no final deste arquivo.
	 */
	app.post("/v1/runs", async (c) => {
		if (!config.agentRunQueue) {
			return c.json({ error: "Agent run queue unavailable" }, 503);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const parsed = parseCreateBody(json, c.req.header("Idempotency-Key"));
		if ("error" in parsed) {
			return c.json({ error: parsed.error }, 400);
		}
		let request = parsed;
		// Grupo de bots: só o clique de confirmação chega aqui (vira run do membro dono do pedido).
		const groupTarget = await resolveGroupRunTarget(request, scopeFor(c.get("session")).userId);
		if (groupTarget.kind === "reject") return c.json({ error: groupTarget.error }, groupTarget.status);
		if (groupTarget.kind === "member") request = { ...request, botId: groupTarget.botId, conversationId: groupTarget.conversationId };
		try { await validateRunReferences(request, scopeFor(c.get("session")).userId); }
		catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			throw error;
		}
		try { const owner = scopeFor(c.get("session")).userId; await resolveUserImagesCard(request.attachments ?? [], owner); await resolveUserFileCards(request.attachments ?? [], owner); }
		catch { return c.json({ error: "anexo inválido" }, 400); }

		const { userId } = scopeFor(c.get("session"));
		// Cofre: valor de segredo conhecido colado no chat vira marcador antes de persistir/enviar ao modelo.
		request = { ...request, messages: await maskKnownSecretsInMessages(userId, request.messages) };
		// Mensagem que não precisa de resposta ("valeu", "ok", 👍): o bot só reage, sem run nem modelo.
		const reacted = await maybeReactOnly({
			request,
			userId,
			deps: dependencies.reactionOnly ?? createReactionOnlyDeps({ apiKey: config.openRouterApiKey, loadAccount: dependencies.getAccountConfig }),
		});
		if (reacted.handled) return c.json(reacted.response, 200);
		const { model, auto: modelAuto } = await resolveRunModelChoice({
			requested: request.model,
			modelAuto: request.modelAuto,
			botId: request.botId,
			userId: scopeFor(c.get("session")).userId,
			envDefault: config.openRouterModel,
			getAccountConfig: dependencies.getAccountConfig,
		});

		const modelError = await validateRunModel(userId, model);
		if (modelError) return c.json({ error: modelError.error }, modelError.status);

		// Só o clique do card de confirmação é resolvido aqui; o resto vai ao agente.
		const lastUser =
			[...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
		try {
			const confirmedAction = await maybeHandleConfirmedAction({
				jevIntent: await buildJevIntentFor(scopeFor(c.get("session")).userId, config.openRouterApiKey, process.env, dependencies.getAccountConfig),
				text: lastUser,
				userId: scopeFor(c.get("session")).userId,
				botId: request.botId,
				conversationId: request.conversationId,
				model,
				continueInAgent: true,
				confirmId: request.decisionConfirmId,
			});
			if (!confirmedAction.handled && confirmedAction.followUp) {
				// Ação MCP confirmada já rodou: o agente continua com o resultado.
				request = {
					...request,
					messages: applyConfirmedFollowUp(request.messages, confirmedAction.followUp),
					objective: confirmedAction.followUp.objective,
					...(confirmedAction.followUp.transcript ? { transcriptSeed: confirmedAction.followUp.transcript } : {}),
				};
			}
			if (!confirmedAction.handled && confirmedAction.duplicate && request.conversationId) {
				// Clique repetido de um cartão já decidido: nada de mensagem nem run novos, só aponta o run da conversa.
				const [latest] = await listRunsForConversation(request.conversationId, { take: 1 });
				if (latest) {
					const body: CreateAgentRunResponse = { runId: latest.id, status: latest.status, enqueued: true };
					return c.json(body, 200);
				}
			}
			if (confirmedAction.handled) {
				const body: CreateAgentRunResponse = {
					runId: confirmedAction.run.id,
					status: confirmedAction.run.status,
					// Run já concluído no servidor: true para não disparar o
					// aviso de "fila indisponível" na UI.
					enqueued: true,
				};
				return c.json(body, 200);
			}
		} catch (error) {
			console.error("confirmed action failed; falling back to agent run", error);
		}

		let run;
		try {
			const { userId } = scopeFor(c.get("session"));
			run = await createAgentRun({
				request,
				model,
				userId,
				modelAuto,
				contextLength: peekModelContextLength(model),
				onMergedIntoActiveRun: (runId) => notifyRunSignal(publish, runId, "input"),
			});
		} catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			// A conversa acabou de ser ocupada/liberada por outro run: nada foi gravado, o cliente pode reenviar.
			if (isActiveRunConflict(error)) return c.json({ error: ACTIVE_RUN_CONFLICT_MESSAGE }, 409);
			const message = error instanceof Error ? error.message : "Falha ao criar run";
			return c.json({ error: message }, 400);
		}

		const enqueued = await enqueueAgentRunJob(config.agentRunQueue, run.id);

		const body: CreateAgentRunResponse = {
			runId: run.id,
			status: run.status,
			enqueued,
		};
		return c.json(body, 202);
	});

	/**
	 * POST /v1/questionnaire/submit — responde um questionário SEM balão user.
	 *
	 * Body: `{ conversationId, questionnaireId, botId?, answers, clientKey? }`
	 * (`answers`: nome -> valor(es), ao menos 1 preenchido).
	 *
	 * 1. Marca o card como `submitted` persistindo as respostas (404 se o card
	 *    não existe ou já foi respondido/dispensado).
	 * 2. Cria um AgentRun silencioso (`silent`, sem mensagem user na thread)
	 *    com as respostas em `messages[].user` JSON + system sem
	 *    reapresentação, e enfileira. O bot confirma em meia frase, faz a
	 *    próxima pergunta (máx. 3) ou consolida via `memory`.
	 */
	app.post("/v1/questionnaire/submit", async (c) => {
		if (!config.agentRunQueue) {
			return c.json({ error: "Agent run queue unavailable" }, 503);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const parsed = parseQuestionnaireAnswerBody(json);
		if (!parsed) {
			return c.json(
				{
					error:
						"Invalid body: expected { conversationId, questionnaireId, answers } with at least one answer",
				},
				400,
			);
		}

		const { userId } = scopeFor(c.get("session"));
		if (!(await getOwnedConversation(parsed.conversationId, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		try { await validateRunReferences(parsed, userId); }
		catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			throw error;
		}

		// Resposta de questionário não traz `model`: herda o do bot, não o do .env.
		const model = await resolveRunModel({
			botId: parsed.botId,
			userId,
			envDefault: config.openRouterModel,
			getAccountConfig: dependencies.getAccountConfig,
		});

		const modelError = await validateRunModel(userId, model);
		if (modelError) return c.json({ error: modelError.error }, modelError.status);

		let card: Awaited<ReturnType<typeof submitQuestionnaireCard>>;
		try {
			card = await submitQuestionnaireCard(
				parsed.conversationId,
				parsed.questionnaireId,
				parsed.answers,
			);
			if (!card) {
				return c.json(
					{ error: "Questionnaire not found or already answered" },
					404,
				);
			}
		} catch (error) {
			console.error("submit questionnaire card failed", error);
			return c.json({ error: "Failed to submit questionnaire" }, 503);
		}

		const submittedAt = new Date().toISOString();
		const clientKey = (
			parsed.clientKey ??
			(c.req.header("Idempotency-Key")?.trim() ||
				questionnaireAnswerClientKey(parsed.questionnaireId, parsed.answers))
		).slice(0, 128);
		// Instrução por `purpose` do card (task = padrão/seguro; onboarding só
		// no fluxo de config do bot): resposta de questionário de TAREFA nunca
		// deve virar proposta de perfil — bug original que este fix corrige.
		const messages = buildQuestionnaireAnsweredMessages({
			systemInstruction: questionnaireAnswerInstruction({
				purpose: card.purpose,
				originalRequest: card.originalRequest,
			}),
			questionnaireId: parsed.questionnaireId,
			answers: parsed.answers,
			submittedAt,
			purpose: card.purpose ?? "task",
			originalRequest: card.originalRequest,
		});
		const request: CreateAgentRunRequest = {
			messages,
			botId: parsed.botId,
			conversationId: parsed.conversationId,
			origin: "chat",
			objective: buildQuestionnaireAnsweredObjective(
				parsed.questionnaireId,
				Object.keys(parsed.answers),
			),
			silent: true,
			clientKey,
		};

		let run;
		try {
			run = await createAgentRun({
				request,
				model,
				userId,
				contextLength: peekModelContextLength(model),
				onMergedIntoActiveRun: (runId) => notifyRunSignal(publish, runId, "input"),
			});
		} catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			if (isActiveRunConflict(error)) return c.json({ error: ACTIVE_RUN_CONFLICT_MESSAGE }, 409);
			const message =
				error instanceof Error ? error.message : "Falha ao criar run";
			return c.json({ error: message }, 400);
		}

		const enqueued = await enqueueAgentRunJob(config.agentRunQueue, run.id);

		const body: CreateAgentRunResponse = {
			runId: run.id,
			status: run.status,
			enqueued,
		};
		return c.json(body, 202);
	});

	app.get("/v1/runs/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(c.req.param("id"), userId);
		if (!run) return c.json({ error: "Run not found" }, 404);
		return c.json({ run });
	});

	app.get("/v1/runs/:id/events", async (c) => {
		const runId = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Run not found" }, 404);

		const afterRaw = c.req.query("after");
		const after = afterRaw ? Number.parseInt(afterRaw, 10) : 0;
		const events = await listRunEventsAfter(
			runId,
			Number.isFinite(after) ? after : 0,
		);

		return c.json({
			events,
			run: {
				id: run.id,
				status: run.status,
				resultText: run.resultText,
				error: run.error,
			},
		});
	});

	app.get("/v1/runs/:id/stream", async (c) => {
		const runId = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Run not found" }, 404);

		const lastEventIdHeader = c.req.header("Last-Event-ID");
		const afterQuery = c.req.query("after");
		let cursor = Number.parseInt(afterQuery || lastEventIdHeader || "0", 10);
		if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

		const stream = createRunObserver(c.req.raw.signal, async (observer) => {
			await runRunStream(cursor, {
				getState: () => getAgentRunStreamState(runId, userId),
				listEvents: (after, limit) => listRunEventsAfter(runId, after, limit),
				subscribe: (onWake) => subscribeEvents(runId, onWake),
				io: { stopped: observer.stopped, send: observer.send, wait: observer.wait, wakeUp: observer.wakeUp },
			});
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	});

	app.post("/v1/runs/:id/cancel", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const owned = await getAgentRunForUser(c.req.param("id"), userId);
		if (!owned) return c.json({ error: "Run not found" }, 404);
		const run = await requestCancelAgentRun(c.req.param("id"));
		if (!run) return c.json({ error: "Run not found" }, 404);
		await notifyRunSignal(publish, run.id, "cancel");
		return c.json({ run });
	});

	app.post("/v1/runs/:id/pause", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const owned = await getAgentRunForUser(c.req.param("id"), userId);
		if (!owned) return c.json({ error: "Run not found" }, 404);
		const run = await requestPauseAgentRun(c.req.param("id"));
		if (!run) return c.json({ error: "Run not found" }, 404);
		// Em `retrying` não há lease nem como pausar com segurança: pausar
		// deixaria o run órfão. Aguardar a nova tentativa ou cancelar.
		if (run.status === "retrying") {
			return c.json(
				{ error: "O agente está tentando de novo; aguarde a tentativa ou cancele" },
				409,
			);
		}
		return c.json({ run }, 202);
	});

	app.post("/v1/runs/:id/resume", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const owned = await getAgentRunForUser(c.req.param("id"), userId);
		if (!owned) {
			return c.json({ error: "Run not found" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as { via?: unknown; code?: unknown } | null;
		const loginCode = body?.via === "code" && typeof body.code === "string" ? body.code.replace(/s+/g, "") : "";
		if (body?.via === "code" && !/^[A-Za-z0-9-]{3,12}$/.test(loginCode)) return c.json({ error: "Código inválido" }, 400);
		const run = await requestResumeAgentRun(c.req.param("id"));
		if (!run) {
			return c.json(
				{ error: "O agente ainda está parando ou não pode ser retomado" },
				409,
			);
		}
		// "Entrar" no card do Cofre: o runtime usa o login ao retomar (o clique é a aprovação).
		if (body?.via === "vault") await markPendingLoginUseVault(run.id).catch(() => false);
		// Código do e-mail/SMS: selado no checkpoint; o runtime digita na página e o modelo nunca o vê.
		if (loginCode) await markPendingLoginCode(run.id, sealSecrets({ code: loginCode })).catch(() => false);
		if (!config.agentRunQueue) {
			return c.json({ error: "Agent run queue unavailable" }, 503);
		}
		const enqueued = await enqueueAgentRunJob(config.agentRunQueue, run.id);
		return c.json({ run, enqueued }, 202);
	});

	app.post("/v1/runs/:id/inputs", async (c) => {
		const runId = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Run not found" }, 404);
		// A sandbox persistida pode ter sido removida pelo reaper. O worker a
		// recupera; continuar/cancelar um run próprio não exige a sessão antiga.
		try { await validateRunReferences({ botId: run.botId, conversationId: run.conversationId }, userId); }
		catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			throw error;
		}
		// Run terminal não consome mais nada: o cliente deve criar um run novo
		// em vez de enterrar a mensagem num steer órfão.
		if (
			run.status === "completed" ||
			run.status === "failed" ||
			run.status === "cancelled" ||
			run.status === "budget_exhausted"
		) {
			return c.json(
				{ error: "Run já terminou; crie um novo run para continuar." },
				409,
			);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!json || typeof json !== "object") {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = json as Record<string, unknown>;
		const attachments = parseImageAttachments(body.attachments);
		if (!attachments) return c.json({ error: "anexos inválidos" }, 400);
		try { await resolveUserImagesCard(attachments, userId); await resolveUserFileCards(attachments, userId); }
		catch { return c.json({ error: "anexo inválido" }, 400); }
		if (typeof body.content !== "string" || body.content.length > API_INPUT_LIMITS.contentChars) {
			return c.json({ error: "content obrigatório" }, 400);
		}
		// join (padrão) | redirect | interrupt | queue | cancel; `steer` legado vira join; desconhecido = 400.
		const mode = parseRunInputMode(body.mode);
		if (!mode) return c.json({ error: "Invalid input mode" }, 400);
		const headerKey = c.req.header("Idempotency-Key");
		const request: CreateRunInputRequest = {
			content: body.content,
			...(attachments.length ? { attachments } : {}),
			mode,
			author: typeof body.author === "string" ? body.author : "user",
			clientKey:
				typeof body.clientKey === "string"
					? body.clientKey
					: typeof headerKey === "string"
						? headerKey
						: undefined,
		};
		// Cancel como intent: sinaliza o run além de registrar o input.
		if (mode === "cancel") {
			await requestCancelAgentRun(runId);
			await notifyRunSignal(publish, runId, "cancel");
		}
		try {
			const input = await createRunInput(runId, request, userId);
			await notifyRunSignal(publish, runId, "input");
			// Run parado (ex.: card de conexão de app) não consome inputs: a mensagem do
			// usuário o acorda, senão ela ficaria pendente e o run "ativo" para sempre.
			if (mode !== "cancel" && run.status === "paused" && config.agentRunQueue) {
				const resumed = await requestResumeAgentRun(runId).catch(() => null);
				if (resumed) await enqueueAgentRunJob(config.agentRunQueue, runId);
			}
			await appendRunEvent(runId, "input_received", {
				type: "input_received",
				inputId: input.id,
				mode: input.mode,
				content: input.content,
			}).catch((error) => console.error("input_received event failed", error));
			return c.json({ input }, 201);
		} catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			const message =
				error instanceof Error ? error.message : "Falha ao criar input";
			return c.json({ error: message }, 400);
		}
	});

	/** "Enviar agora": mensagem da fila passa a entrar no run em andamento (próximo passo do agente). */
	app.post("/v1/runs/:id/inputs/:inputId/steer", async (c) => {
		const runId = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Run not found" }, 404);
		const input = await promoteQueuedInputToSteer(runId, c.req.param("inputId"), userId);
		if (!input) return c.json({ error: "A mensagem não está mais na fila" }, 409);
		await notifyRunSignal(publish, runId, "input");
		return c.json({ input });
	});

	/** "Deixar para quando terminar": a mensagem pendente deixa de entrar no próximo passo e vira fila. */
	app.post("/v1/runs/:id/inputs/:inputId/queue", async (c) => {
		const runId = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Run not found" }, 404);
		const input = await demoteSteerInputToQueue(runId, c.req.param("inputId"), userId);
		if (!input) return c.json({ error: "A mensagem já foi usada pelo agente" }, 409);
		return c.json({ input });
	});

	app.get("/v1/runs/:id/inputs", async (c) => {
		const runId = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Run not found" }, 404);
		const status = c.req.query("status");
		const inputs = await listRunInputs(
			runId,
			status === "pending" || status === "consumed" || status === "superseded"
				? { status }
				: undefined,
		);
		return c.json({ inputs });
	});

	app.get("/v1/conversations/:conversationId/runs", async (c) => {
		const conversationId = c.req.param("conversationId");
		const { userId } = scopeFor(c.get("session"));
		if (!(await getOwnedConversation(conversationId, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		const activeQuery = c.req.query("active");
		const activeOnly = activeQuery !== "0" && activeQuery !== "false";
		const runs = await listRunsForConversation(conversationId, {
			activeOnly,
		});
		return c.json({ runs });
	});

	app.get("/v1/conversations/:conversationId/runs/latest-completed", async (c) => {
		const conversationId = c.req.param("conversationId");
		const { userId } = scopeFor(c.get("session"));
		if (!(await getOwnedConversation(conversationId, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		const run = await getLatestCompletedRunForConversation(conversationId);
		return c.json({ run });
	});

	return app;
}

/**
 * Exemplo — questionário alimenta a memória (sem texto estático; o LLM
 * consolida via tool `memory` target `memory`, category
 * `bot_config`/`bot_evolution`, `importance>=0.7`):
 *
 * ```bash
 * # 1. Briefing consolidado via confirm -> estado atual
 * curl -X PATCH http://localhost:3001/v1/bots/<botId> \
 *   -H 'Content-Type: application/json' \
 *   -d '{"description":"Assistente de vendas, tom direto. Porquê: usuário pediu foco em follow-up."}'
 *
 * # 2. Run com answers como user JSON (origin "chat", clientKey idempotente)
 * curl -X POST http://localhost:3001/v1/runs \
 *   -H 'Content-Type: application/json' \
 *   -d '{
 *     "botId": "<botId>",
 *     "conversationId": "<conversationId>",
 *     "origin": "chat",
 *     "objective": "[questionnaire-submitted] Bot \"Vendas\"",
 *     "clientKey": "questionnaire-submitted:<botId>:<hash>",
 *     "messages": [
 *       {"role":"system","content":"EVENTO DE BOT (criação/fechamento de config/questionário): responda em PT-BR, curto e agêntico. ..."},
 *       {"role":"user","content":"{\"botId\":\"<botId>\",\"event\":\"questionnaire-submitted\",\"answers\":{\"direction\":\"vendas\",\"detail\":\"tom direto, follow-up diário\",\"briefing\":\"Assistente de vendas, tom direto\"},\"submittedAt\":\"2026-09-21T00:00:00.000Z\"}"}
 *     ]
 *   }'
 *
 * # 3. Checar MemoryEntry criada (porquê/histórico botId-escopado)
 * curl 'http://localhost:3001/v1/memory?botId=<botId>' | jq '.snapshot.memory.entries[] | {category, importance, content}'
 * # esperado: category bot_config|bot_evolution, importance>=0.7,
 * # content "<estado>. Porquê: <motivo>"
 * ```
 *
 * Repetição NÃO duplica: `add` idêntico/paráfrase (<0.08) devolve
 * "duplicado"; overflow 2200 chars exige `replace` consolidando.
 */
