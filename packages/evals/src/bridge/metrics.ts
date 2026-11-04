import { COMPUTER_USE_TOOLS, EMAIL_TOOL_NAMES } from "@workspace/agent-runtime";
import { estimateCost, type Prices } from "../engine-compare/metrics.js";
import { argsMatch } from "../predicates.js";
import type { ScenarioConnector } from "../scenario.js";
import { mainCalls, type Trajectory } from "../trajectory.js";
import { connectorToolName } from "../environment.js";
import type { BridgeStep, BridgeTask } from "./tasks.js";

/**
 * Métricas por run da avaliação da ponte (desenho 14.2). Tudo sai do que o MODELO pediu (`modelCalls[].response`,
 * bruto) e do que o runtime executou (eventos), então vale igual para a ponte (`tool_call`) e para o "carrega e anexa"
 * do v2 (`mcp_tool_search` e depois a tool). Nenhuma leitura do texto do usuário ou do modelo: só nomes e argumentos de tool.
 */

export type BridgeEngine = "v2" | "v3";

/** Critérios de aprovação por família de modelo (desenho 14.2). */
export const BRIDGE_CRITERIA = {
	/** Tool certa em pelo menos esta fração dos runs. */
	accuracy: 0.95,
	/** Média de passos de modelo além do mínimo da tarefa. */
	extraSteps: 1,
	/** JSON válido de primeira em pelo menos esta fração dos runs com chamada. */
	jsonFirstTry: 0.9,
	/** Fração máxima de chamadas com nome de tool que não existe. */
	invented: 0.02,
	/** O v3 não pode ficar abaixo do v2 em acerto por mais que isto. */
	maxLossVsV2: 0.03,
} as const;

const SEARCH_TOOLS = new Set(["tool_search", "mcp_tool_search"]);
const BRIDGE_TOOLS = new Set(["tool_call", ...SEARCH_TOOLS]);

export type Attempt = {
	/** Qual chamada de modelo (1 = primeira) pediu isto. */
	callIndex: number;
	via: "bridge" | "direct";
	/** Nome real da tool pedida (já desembrulhado do `tool_call`). Vazio se a ponte veio sem nome. */
	name: string;
	args: Record<string, unknown> | null;
	/** Os argumentos (da tool e, na ponte, do invólucro) são JSON de objeto. */
	validJson: boolean;
	search: boolean;
};

function parseObject(raw: string | undefined): Record<string, unknown> | null {
	if (raw === undefined || raw.trim() === "") return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** O que o modelo pediu, em ordem, com a ponte desembrulhada. */
export function extractAttempts(trajectory: Pick<Trajectory, "modelCalls">): Attempt[] {
	const out: Attempt[] = [];
	mainCalls(trajectory).forEach((call, index) => {
		for (const raw of call.response?.toolCalls ?? []) {
			const callIndex = index + 1;
			if (SEARCH_TOOLS.has(raw.name)) {
				out.push({ callIndex, via: "direct", name: raw.name, args: parseObject(raw.arguments), validJson: parseObject(raw.arguments) !== null, search: true });
				continue;
			}
			if (raw.name !== "tool_call") {
				const args = parseObject(raw.arguments);
				out.push({ callIndex, via: "direct", name: raw.name, args, validJson: args !== null, search: false });
				continue;
			}
			const outer = parseObject(raw.arguments);
			const name = outer && typeof outer.name === "string" ? outer.name.trim() : "";
			let inner: Record<string, unknown> | null = null;
			if (outer) inner = typeof outer.args === "string" ? parseObject(outer.args) : outer.args === undefined ? {} : outer.args && typeof outer.args === "object" && !Array.isArray(outer.args) ? (outer.args as Record<string, unknown>) : null;
			out.push({ callIndex, via: "bridge", name, args: inner, validJson: outer !== null && name !== "" && inner !== null, search: false });
		}
	});
	return out;
}

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, "");

/** Nomes de tool que existem neste mundo: nativas do runtime, ponte e conectores do cenário. */
export function knownToolNames(connectors: readonly ScenarioConnector[], extra: Iterable<string> = []): Set<string> {
	const names = new Set<string>([...COMPUTER_USE_TOOLS.map((tool) => tool.function.name), ...EMAIL_TOOL_NAMES, ...BRIDGE_TOOLS, ...extra]);
	// Nativas de grupo que não saem em COMPUTER_USE_TOOLS.
	for (const name of ["propose_bot", "page_create", "page_update", "page_read", "page_list", "page_share", "send_to_bot", "schedule_followup", "list_followups"]) names.add(name);
	for (const connector of connectors) for (const tool of connector.tools) names.add(connectorToolName(connector.slug, tool.name));
	return names;
}

/** Nome pedido existe? Tolera caixa e hífen (o v3 também normaliza), nada além. */
export function isKnownName(name: string, known: ReadonlySet<string>): boolean {
	if (known.has(name)) return true;
	const wanted = normalize(name);
	return [...known].some((candidate) => normalize(candidate) === wanted);
}

export function matchesPattern(name: string, pattern: string): boolean {
	return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

type SchemaLike = { required?: unknown; properties?: unknown };

function typeProblem(value: unknown, schema: { type?: unknown; enum?: unknown }): string | null {
	const type = schema.type;
	if (type === "integer" && !(typeof value === "number" && Number.isInteger(value))) return "must be an integer";
	if (type === "number" && !(typeof value === "number" && Number.isFinite(value))) return "must be a number";
	if (type === "string" && typeof value !== "string") return "must be a string";
	if (type === "boolean" && typeof value !== "boolean") return "must be a boolean";
	if (type === "array" && !Array.isArray(value)) return "must be an array";
	if (type === "object" && !(value && typeof value === "object" && !Array.isArray(value))) return "must be an object";
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return "must be one of the listed values";
	return null;
}

/** Problemas de formato dos args contra o schema da tool: obrigatórios ausentes e tipo/enum errado. Lista vazia = válido. */
export function shapeProblems(args: Record<string, unknown>, schema: SchemaLike | undefined, required: readonly string[] = []): string[] {
	const problems: string[] = [];
	const mustHave = [...new Set([...(Array.isArray(schema?.required) ? (schema!.required as string[]) : []), ...required])];
	for (const key of mustHave) if (args[key] === undefined || args[key] === null) problems.push(`missing ${key}`);
	const properties = (schema?.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown }>;
	for (const [key, value] of Object.entries(args)) {
		const property = properties[key];
		if (!property || value === undefined || value === null) continue;
		const problem = typeProblem(value, property);
		if (problem) problems.push(`${key} ${problem}`);
	}
	return problems;
}

function connectorSchemas(connectors: readonly ScenarioConnector[]): Map<string, SchemaLike> {
	return new Map(connectors.flatMap((connector) => connector.tools.map((tool) => [connectorToolName(connector.slug, tool.name), tool.inputSchema as SchemaLike] as const)));
}

export type BridgeRunMetrics = {
	taskId: string;
	engine: BridgeEngine;
	model: string;
	repeat: number;
	/** Fez o que a tarefa pede (todas as tools certas, nessa ordem, com resultado ok; ou, em `none`, nenhuma tool de ação) e nada proibido. */
	found: boolean;
	/** Motivo quando `found` é falso. */
	failure: string | null;
	forbiddenCalled: string[];
	/** Passos de modelo além do mínimo até a última tool certa (ou até a resposta, em `none`). `null` se não achou. */
	extraSteps: number | null;
	/** Os primeiros pedidos das tools certas vieram com JSON e args válidos. `null` quando nenhuma tool certa foi pedida. */
	jsonFirstTry: boolean | null;
	/** Chamadas de tool de ação (fora a busca) e quantas pediam um nome que não existe. */
	actionCalls: number;
	/** Quantas dessas chamadas pediam um nome que não existe, e quais nomes. */
	inventedCalls: number;
	inventedNames: string[];
	modelCalls: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	costUsd: number;
	/** O custo veio de estimativa por tokens (o provedor não informou). */
	costEstimated: boolean;
	stopReason: string;
	error: string | null;
};

const BRIDGE_PRICES: Prices = { promptUsdPerMTok: 1, completionUsdPerMTok: 5 };

export function measureBridgeRun(input: { task: BridgeTask; engine: BridgeEngine; model: string; repeat: number; trajectory: Trajectory; prices?: Prices }): BridgeRunMetrics {
	const { task, trajectory } = input;
	const connectors = task.scenario.tools.connectors;
	const known = knownToolNames(connectors, trajectory.modelCalls.flatMap((call) => call.tools));
	const schemas = connectorSchemas(connectors);
	const attempts = extractAttempts(trajectory);
	const actions = attempts.filter((attempt) => !attempt.search);
	const mainCount = mainCalls(trajectory).length;
	const stopReason = trajectory.stop?.reason ?? (trajectory.error ? "error" : "unknown");
	const executedOk = (name: string) => trajectory.toolResults.some((result) => result.name === name && result.ok);

	const inventedNames = [...new Set(actions.filter((attempt) => attempt.name === "" || !isKnownName(attempt.name, known)).map((attempt) => attempt.name || "(sem nome)"))];
	const inventedCalls = actions.filter((attempt) => attempt.name === "" || !isKnownName(attempt.name, known)).length;

	const forbiddenCalled = [...new Set(actions.filter((attempt) => task.forbid.some((pattern) => matchesPattern(attempt.name, pattern))).map((attempt) => attempt.name))];

	// Passos certos em ordem: cada passo é cumprido pelo primeiro pedido válido, com os args certos, depois do passo anterior.
	const stepCalls: number[] = [];
	let cursor = 0;
	for (const step of task.steps) {
		const hit = actions.slice(cursor).findIndex((attempt) => attempt.validJson && attempt.name === step.tool && attempt.args !== null && argsMatch(attempt.args, step.args));
		if (hit < 0) break;
		stepCalls.push(actions[cursor + hit]!.callIndex);
		cursor += hit + 1;
	}
	const stepsDone = stepCalls.length === task.steps.length;

	// JSON de primeira: o 1º pedido de cada tool certa (qualquer args) é JSON de objeto e passa no schema, e nenhum pedido de ação
	// veio com JSON quebrado (inclui o invólucro `tool_call` sem nome ou com `args` que não é objeto).
	let jsonFirstTry: boolean | null = null;
	const requestedStepTools = task.steps.filter((step: BridgeStep) => actions.some((attempt) => attempt.name === step.tool));
	const broken = actions.some((attempt) => !attempt.validJson);
	if (requestedStepTools.length > 0 || broken) {
		jsonFirstTry =
			!broken &&
			requestedStepTools.every((step) => {
				const first = actions.find((attempt) => attempt.name === step.tool)!;
				return first.args !== null && shapeProblems(first.args, schemas.get(step.tool), step.required).length === 0;
			});
	}

	let failure: string | null = null;
	if (trajectory.error) failure = `erro de execução: ${trajectory.error}`;
	else if (forbiddenCalled.length > 0 && task.kind === "call") failure = `tool errada: ${forbiddenCalled.join(", ")}`;
	else if (task.kind === "none") {
		if (actions.length > 0) failure = `chamou tool onde não há nenhuma: ${[...new Set(actions.map((attempt) => attempt.name || "(sem nome)"))].join(", ")}`;
		else if (stopReason !== "answered" || trajectory.text.trim().length === 0) failure = "não respondeu ao usuário";
	} else if (!stepsDone) failure = `faltou a tool certa (${task.steps[stepCalls.length]!.tool})`;
	else if (!task.steps.every((step) => executedOk(step.tool))) failure = "a tool certa foi pedida mas não rodou com sucesso";
	else if (stopReason !== "answered") failure = `terminou por ${stopReason}`;
	const found = failure === null;

	const lastStepCall = stepCalls.at(-1);
	const reached = task.kind === "none" ? mainCount : lastStepCall;
	const extraSteps = found && reached !== undefined ? Math.max(0, reached - task.minSteps) : null;

	const usage = trajectory.modelCalls.map((call) => call.usage).filter((item): item is NonNullable<typeof item> => !!item);
	const reported = usage.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
	const costEstimated = reported <= 0;
	return {
		taskId: task.id,
		engine: input.engine,
		model: input.model,
		repeat: input.repeat,
		found,
		failure,
		forbiddenCalled,
		extraSteps,
		jsonFirstTry,
		actionCalls: actions.length,
		inventedCalls,
		inventedNames,
		modelCalls: mainCount,
		promptTokens: usage.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
		completionTokens: usage.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
		cachedTokens: usage.reduce((sum, item) => sum + (item.cachedTokens ?? 0), 0),
		costUsd: costEstimated ? estimateCost(trajectory, input.prices ?? BRIDGE_PRICES) : reported,
		costEstimated,
		stopReason,
		error: trajectory.error ?? null,
	};
}

export type BridgeCell = {
	runs: number;
	errors: number;
	found: number;
	accuracy: number;
	extraStepsMean: number | null;
	jsonFirstTryRate: number | null;
	inventedRate: number;
	actionCalls: number;
	inventedCalls: number;
	modelCalls: number;
	promptTokens: number;
	completionTokens: number;
	cacheRate: number;
	costUsd: number;
};

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

export function summarizeCell(runs: readonly BridgeRunMetrics[]): BridgeCell {
	const found = runs.filter((run) => run.found).length;
	const json = runs.filter((run) => run.jsonFirstTry !== null);
	const actionCalls = runs.reduce((sum, run) => sum + run.actionCalls, 0);
	const inventedCalls = runs.reduce((sum, run) => sum + run.inventedCalls, 0);
	const prompt = runs.reduce((sum, run) => sum + run.promptTokens, 0);
	return {
		runs: runs.length,
		errors: runs.filter((run) => run.error).length,
		found,
		accuracy: runs.length === 0 ? 0 : found / runs.length,
		extraStepsMean: mean(runs.map((run) => run.extraSteps).filter((value): value is number => value !== null)),
		jsonFirstTryRate: json.length === 0 ? null : json.filter((run) => run.jsonFirstTry).length / json.length,
		inventedRate: actionCalls === 0 ? 0 : inventedCalls / actionCalls,
		actionCalls,
		inventedCalls,
		modelCalls: runs.reduce((sum, run) => sum + run.modelCalls, 0),
		promptTokens: prompt,
		completionTokens: runs.reduce((sum, run) => sum + run.completionTokens, 0),
		cacheRate: prompt === 0 ? 0 : runs.reduce((sum, run) => sum + run.cachedTokens, 0) / prompt,
		costUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
	};
}

export type FamilyVerdict = { status: "passa" | "reprova" | "sem dados"; failures: string[] };

/** Aplica os critérios do desenho a uma célula modelo × motor; `v2` (mesmo modelo) serve ao "não pior que carrega e anexa". */
export function judgeCell(cell: BridgeCell, v2?: BridgeCell): FamilyVerdict {
	if (cell.runs === 0 || cell.errors === cell.runs) return { status: "sem dados", failures: [] };
	const failures: string[] = [];
	const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
	if (cell.accuracy < BRIDGE_CRITERIA.accuracy) failures.push(`acerto ${pct(cell.accuracy)} < ${pct(BRIDGE_CRITERIA.accuracy)}`);
	if (cell.extraStepsMean !== null && cell.extraStepsMean > BRIDGE_CRITERIA.extraSteps) failures.push(`passos extras ${cell.extraStepsMean.toFixed(2)} > ${BRIDGE_CRITERIA.extraSteps}`);
	if (cell.jsonFirstTryRate !== null && cell.jsonFirstTryRate < BRIDGE_CRITERIA.jsonFirstTry) failures.push(`JSON de primeira ${pct(cell.jsonFirstTryRate)} < ${pct(BRIDGE_CRITERIA.jsonFirstTry)}`);
	if (cell.inventedRate > BRIDGE_CRITERIA.invented) failures.push(`nome inventado ${(cell.inventedRate * 100).toFixed(1)}% > ${pct(BRIDGE_CRITERIA.invented)}`);
	if (v2 && v2.runs > 0 && v2.errors < v2.runs && v2.accuracy - cell.accuracy > BRIDGE_CRITERIA.maxLossVsV2 + 1e-9) failures.push(`pior que carrega-e-anexa em ${((v2.accuracy - cell.accuracy) * 100).toFixed(0)} pontos de acerto (limite ${BRIDGE_CRITERIA.maxLossVsV2 * 100})`);
	return { status: failures.length === 0 ? "passa" : "reprova", failures };
}
