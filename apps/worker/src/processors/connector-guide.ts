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
	type GuideToolInput,
} from "@workspace/shared";
import {
	addGuideSuggestion,
	getApiConnectionWithCatalog,
	getConnectorGuide,
	getMcpConnection,
	setConnectorGuide,
} from "@workspace/db";
import { completeChat } from "@workspace/llm";
import type { WorkerConfig } from "../config.js";
import { resolveMaintenanceModelForJob } from "../run-config.js";

/** Injetável nos testes: modelo de manutenção e chamada ao LLM. */
export type ConnectorGuideDeps = {
	resolveModel?: (userId: string) => Promise<string>;
	complete?: typeof completeChat;
};

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

/** Gera (ou regenera) o guia de uso de uma conexão com o modelo de manutenção da conta. Nunca atropela edição do usuário sem `force`. */
export async function processConnectorGuideJob(
	job: Job<ConnectorGuideJobPayload, ConnectorGuideJobResult>,
	config: WorkerConfig,
	deps: ConnectorGuideDeps = {},
): Promise<ConnectorGuideJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.connectorGuide) throw new Error(`Unexpected job name: ${job.name}`);
	if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured on the worker");
	const { kind, connectionId, userId, force } = job.data;
	const current = await getConnectorGuide(kind, connectionId, userId);
	if (!current.found) return { status: "skipped", reason: "conexão não encontrada" };
	// Sem `force`, só gera quando ainda não há guia (jobs duplicados na conexão são inofensivos).
	if (current.guide?.text.trim() && !force) return { status: "skipped", reason: "guia já existe" };
	const connector = await loadConnector({ kind, connectionId, userId });
	if (!connector || connector.tools.length === 0) return { status: "skipped", reason: "sem ferramentas" };
	const model = await (deps.resolveModel ?? ((id) => resolveMaintenanceModelForJob({ kind: "connector-guide", config, userId: id })))(userId);
	const result = await (deps.complete ?? completeChat)({
		messages: [
			{ role: "system", content: GUIDE_GENERATOR_SYSTEM },
			{ role: "user", content: buildConnectorGuidePrompt({ name: connector.name, kind, tools: connector.tools }) },
		],
		model,
		apiKey: config.openRouterApiKey,
	});
	const text = sanitizeGuideText(result.message.content ?? "");
	if (!text) return { status: "failed", reason: "gerador retornou vazio" };
	await setConnectorGuide(kind, connectionId, userId, { text, source: "generated", force });
	console.log(`[connector.guide] done job=${job.id} kind=${kind} connection=${connectionId} chars=${text.length}`);
	return { status: "generated" };
}

/** Uma lição curta (falha → sucesso do mesmo conector) vira sugestão pendente; nada é aplicado sozinho. */
export async function processConnectorLessonJob(
	job: Job<ConnectorLessonJobPayload, ConnectorLessonJobResult>,
	config: WorkerConfig,
	deps: ConnectorGuideDeps = {},
): Promise<ConnectorLessonJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.connectorLesson) throw new Error(`Unexpected job name: ${job.name}`);
	if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured on the worker");
	const { kind, connectionId, userId, failed, succeeded } = job.data;
	const current = await getConnectorGuide(kind, connectionId, userId);
	if (!current.found) return { status: "skipped", reason: "conexão não encontrada" };
	const connector = await loadConnector({ kind, connectionId, userId });
	if (!connector) return { status: "skipped", reason: "conexão indisponível" };
	const model = await (deps.resolveModel ?? ((id) => resolveMaintenanceModelForJob({ kind: "connector-guide", config, userId: id })))(userId);
	const result = await (deps.complete ?? completeChat)({
		messages: [
			{ role: "system", content: LESSON_SYSTEM },
			{ role: "user", content: buildConnectorLessonPrompt({ name: connector.name, failed, succeeded }) },
		],
		model,
		apiKey: config.openRouterApiKey,
	});
	const bullet = parseLessonBullet(result.message.content ?? "");
	if (!bullet) return { status: "skipped", reason: "sem lição geral" };
	const saved = await addGuideSuggestion(kind, connectionId, userId, bullet);
	return saved ? { status: "suggested" } : { status: "skipped", reason: "duplicada ou limite de sugestões" };
}
