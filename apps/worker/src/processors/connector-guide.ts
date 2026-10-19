import type { Job } from "bullmq";
import {
	ATLAS_JOB_NAMES,
	GUIDE_GENERATOR_SYSTEM,
	LESSON_SYSTEM,
	buildConnectorGuidePrompt,
	buildConnectorLessonPrompt,
	parseLessonBullet,
	sanitizeGuideText,
	type ConnectorGuideJobPayload,
	type ConnectorGuideJobResult,
	type ConnectorLessonJobPayload,
	type ConnectorLessonJobResult,
	MAINTENANCE_NO_KEY_MESSAGE,
	type GuideToolInput,
} from "@workspace/shared";
import {
	addGuideSuggestion,
	clearGuideStatus,
	getApiConnectionWithCatalog,
	getConnectorGuide,
	getMcpConnection,
	markGuideFailed,
	setConnectorGuide,
} from "@workspace/db";
import { OpenRouterError, ProviderApiError } from "@workspace/llm";
import type { WorkerConfig } from "../config.js";
import { createMaintenanceLlm, type MaintenanceLlm } from "../maintenance-llm.js";

/** Injetável nos testes: modelo de manutenção e chamada ao LLM. */
export type ConnectorGuideDeps = {
	llm?: (userId: string, config: WorkerConfig) => Promise<MaintenanceLlm>;
};

const llmFor = (kind: "connector-guide", config: WorkerConfig, userId: string, deps: ConnectorGuideDeps): Promise<MaintenanceLlm> =>
	(deps.llm ?? ((id, cfg) => createMaintenanceLlm({ kind, config: cfg, userId: id })))(userId, config);

type LoadedConnector = { name: string; tools: GuideToolInput[] };

/** Ferramentas/operações da conexão do dono, no formato neutro do gerador. */
async function loadConnector(payload: { kind: "mcp" | "api"; connectionId: string; userId: string }): Promise<LoadedConnector | null> {
	if (payload.kind === "mcp") {
		const record = await getMcpConnection(payload.connectionId, payload.userId);
		if (!record || record.status !== "connected") return null;
		return {
			name: record.name,
			tools: record.tools.filter((tool) => !record.disabledTools.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
		};
	}
	const record = await getApiConnectionWithCatalog(payload.connectionId, payload.userId);
	if (!record || record.status !== "connected") return null;
	return {
		name: record.name,
		tools: record.catalog.map((op) => ({
			name: `${op.id} ${op.method} ${op.path}`,
			description: op.summary,
			inputSchema: {
				type: "object",
				properties: Object.fromEntries(op.params.map((param) => [param.name, { type: param.type ?? "string", description: param.in === "path" ? "path" : undefined }])),
				required: op.params.filter((param) => param.required).map((param) => param.name),
			},
		})),
	};
}

/** Falha com mensagem pronta para o usuário (português, sem segredo nem detalhe bruto do provedor). */
export class GuideFailure extends Error {
	constructor(
		readonly userMessage: string,
		readonly retryable = false,
	) {
		super(userMessage);
		this.name = "GuideFailure";
	}
}

/** Erro qualquer → mensagem segura + se vale tentar de novo. */
export function describeGuideError(error: unknown): { message: string; retryable: boolean } {
	if (error instanceof GuideFailure) return { message: error.userMessage, retryable: error.retryable };
	if (error instanceof OpenRouterError || error instanceof ProviderApiError) {
		const status = error.status;
		if (/data policy|guardrail|ZDR/i.test(error.message)) return { message: "O modelo de manutenção não atende a política de privacidade da sua conta no provedor; escolha outro em Modelos e contexto", retryable: false };
		if (status === 401 || status === 403) return { message: "O servidor não conseguiu usar a chave do provedor", retryable: false };
		if (status === 402) return { message: "Sem créditos no provedor do modelo", retryable: false };
		if (status === 400 || status === 404) return { message: "Modelo de manutenção indisponível", retryable: false };
		if (status === 429) return { message: "O provedor limitou o uso agora; tente em instantes", retryable: true };
		if (/empty assistant message/i.test(error.message)) return { message: "O modelo devolveu resposta vazia", retryable: true };
		return { message: "O provedor do modelo falhou; tente de novo", retryable: true };
	}
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return { message: "O modelo demorou demais; tente de novo", retryable: true };
	return { message: "Não foi possível gerar o guia; tente de novo", retryable: true };
}

async function generateGuide(
	job: Job<ConnectorGuideJobPayload, ConnectorGuideJobResult>,
	config: WorkerConfig,
	deps: ConnectorGuideDeps,
): Promise<ConnectorGuideJobResult> {
	const { kind, connectionId, userId, force } = job.data;
	const current = await getConnectorGuide(kind, connectionId, userId);
	if (!current.found) return { status: "skipped", reason: "conexão não encontrada" };
	// Sem `force`, só gera quando ainda não há guia (jobs duplicados na conexão são inofensivos).
	if (current.guide?.text.trim() && !force) {
		await clearGuideStatus(kind, connectionId, userId);
		return { status: "skipped", reason: "guia já existe" };
	}
	const llm = await llmFor("connector-guide", config, userId, deps).catch(() => {
		throw new GuideFailure("Modelo de manutenção indisponível");
	});
	if (llm.candidates.length === 0) {
		await llm.report({ ok: false, error: new Error(MAINTENANCE_NO_KEY_MESSAGE) });
		throw new GuideFailure(MAINTENANCE_NO_KEY_MESSAGE);
	}
	const connector = await loadConnector({ kind, connectionId, userId });
	if (!connector) throw new GuideFailure("A conexão não está ativa");
	if (connector.tools.length === 0) throw new GuideFailure("O conector não tem operações");
	const result = await llm
		.complete({
			messages: [
				{ role: "system", content: GUIDE_GENERATOR_SYSTEM },
				{ role: "user", content: buildConnectorGuidePrompt({ name: connector.name, kind, tools: connector.tools }) },
			],
			model: llm.model,
			apiKey: "",
		})
		.catch(async (error: unknown) => {
			await llm.report({ ok: false, error: new Error(describeGuideError(error).message) });
			throw error;
		});
	const text = sanitizeGuideText(result.message.content ?? "");
	if (!text) throw new GuideFailure("O modelo devolveu resposta vazia", true);
	await setConnectorGuide(kind, connectionId, userId, { text, source: "generated", force });
	await llm.report({ ok: true });
	console.log(`[connector.guide] done job=${job.id} kind=${kind} connection=${connectionId} chars=${text.length}`);
	return { status: "generated" };
}

/** Gera (ou regenera) o guia de uma conexão com o modelo de manutenção da conta. Nunca atropela edição do usuário sem `force`. Toda falha fica gravada na conexão para a UI mostrar. */
export async function processConnectorGuideJob(
	job: Job<ConnectorGuideJobPayload, ConnectorGuideJobResult>,
	config: WorkerConfig,
	deps: ConnectorGuideDeps = {},
): Promise<ConnectorGuideJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.connectorGuide) throw new Error(`Unexpected job name: ${job.name}`);
	const { kind, connectionId, userId } = job.data;
	try {
		return await generateGuide(job, config, deps);
	} catch (error) {
		const { message, retryable } = describeGuideError(error);
		const lastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
		console.error(`[connector.guide] failed job=${job.id} kind=${kind} connection=${connectionId} reason="${message}" cause=${error instanceof Error ? error.name : "unknown"}`);
		if (retryable && !lastAttempt) throw error;
		await markGuideFailed(kind, connectionId, userId, message).catch(() => false);
		if (retryable) throw error;
		return { status: "failed", reason: message };
	}
}

/** Uma lição curta (falha → sucesso do mesmo conector) vira sugestão pendente; nada é aplicado sozinho. */
export async function processConnectorLessonJob(
	job: Job<ConnectorLessonJobPayload, ConnectorLessonJobResult>,
	config: WorkerConfig,
	deps: ConnectorGuideDeps = {},
): Promise<ConnectorLessonJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.connectorLesson) throw new Error(`Unexpected job name: ${job.name}`);
	const { kind, connectionId, userId, failed, succeeded } = job.data;
	const current = await getConnectorGuide(kind, connectionId, userId);
	if (!current.found) return { status: "skipped", reason: "conexão não encontrada" };
	const connector = await loadConnector({ kind, connectionId, userId });
	if (!connector) return { status: "skipped", reason: "conexão indisponível" };
	const llm = await llmFor("connector-guide", config, userId, deps);
	if (llm.candidates.length === 0) throw new Error(MAINTENANCE_NO_KEY_MESSAGE);
	const result = await llm.complete({
		messages: [
			{ role: "system", content: LESSON_SYSTEM },
			{ role: "user", content: buildConnectorLessonPrompt({ name: connector.name, failed, succeeded }) },
		],
		model: llm.model,
		apiKey: "",
	});
	const bullet = parseLessonBullet(result.message.content ?? "");
	if (!bullet) return { status: "skipped", reason: "sem lição geral" };
	const saved = await addGuideSuggestion(kind, connectionId, userId, bullet);
	return saved ? { status: "suggested" } : { status: "skipped", reason: "duplicada ou limite de sugestões" };
}
