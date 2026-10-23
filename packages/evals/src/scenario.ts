import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Formato do cenário de avaliação (versionado). Um cenário é um JSON com a conversa, o perfil do bot, as tools
 * disponíveis com resultados congelados (fixtures, nunca chamada externa real) e as expectativas determinísticas.
 * Campo desconhecido é erro: um cenário com chave errada passaria "verde" sem conferir nada.
 */

export const SCENARIO_VERSION = 1;

const LANGUAGES = ["pt-BR", "en-US", "es-ES"] as const;
export type ScenarioLanguage = (typeof LANGUAGES)[number];

/** Predicado sobre um valor de argumento (caminho com pontos: `items.0.sku`). */
const predicate = z
	.object({
		equals: z.unknown().optional(),
		contains: z.string().optional(),
		matches: z.string().optional(),
		exists: z.boolean().optional(),
		oneOf: z.array(z.unknown()).optional(),
	})
	.strict();
export type ArgPredicate = z.infer<typeof predicate>;
const argPredicates = z.record(z.string(), predicate);
export type ArgPredicates = z.infer<typeof argPredicates>;

const toolCall = z.object({ id: z.string().min(1), name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }).strict();

const historyMessage = z.union([
	z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict(),
	z.object({ role: z.literal("assistant"), content: z.string().nullable().optional(), toolCalls: z.array(toolCall).min(1) }).strict(),
	z.object({ role: z.literal("tool"), toolCallId: z.string().min(1), content: z.string() }).strict(),
]);
export type HistoryMessage = z.infer<typeof historyMessage>;

const toolResult = z.object({ ok: z.boolean().default(true), summary: z.string() }).strict();

/** Tool nativa interceptada: o primeiro fixture cujo `tool` e `args` batem responde no lugar do executor. */
const nativeFixture = z.object({ tool: z.string().min(1), args: argPredicates.optional(), result: toolResult }).strict();
export type NativeFixture = z.infer<typeof nativeFixture>;

const connectorResponse = z.object({ args: argPredicates.optional(), ok: z.boolean().default(true), text: z.string() }).strict();
const connectorTool = z
	.object({
		name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		description: z.string().min(1),
		inputSchema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
		readOnly: z.boolean().default(true),
		destructive: z.boolean().default(false),
		responses: z.array(connectorResponse).default([]),
	})
	.strict();
const connector = z
	.object({
		slug: z.string().regex(/^[a-z0-9_]+$/),
		name: z.string().min(1),
		/** Tools do conector já carregadas no 1º passo (como uma menção `@App`). */
		preload: z.boolean().default(false),
		tools: z.array(connectorTool).min(1),
	})
	.strict();
export type ScenarioConnector = z.infer<typeof connector>;

const mockTurn = z.union([
	z.object({ say: z.string() }).strict(),
	z.object({ calls: z.array(z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1) }).strict(),
]);
export type MockTurn = z.infer<typeof mockTurn>;

const toolRef = z.object({ tool: z.string().optional(), toolPattern: z.string().optional() }).strict();

const base = { id: z.string().optional() };
const expectation = z.discriminatedUnion("type", [
	z.object({ ...base, type: z.literal("tool_called"), ...toolRef.shape, args: argPredicates.optional(), min: z.number().int().min(1).optional(), max: z.number().int().min(0).optional() }).strict(),
	z.object({ ...base, type: z.literal("tool_not_called"), ...toolRef.shape, args: argPredicates.optional() }).strict(),
	z.object({ ...base, type: z.literal("no_question") }).strict(),
	z.object({ ...base, type: z.literal("asks_question"), max: z.number().int().min(1).default(2) }).strict(),
	z.object({ ...base, type: z.literal("text_contains"), value: z.string().optional(), pattern: z.string().optional(), ignoreCase: z.boolean().default(false) }).strict(),
	z.object({ ...base, type: z.literal("text_not_contains"), value: z.string().optional(), pattern: z.string().optional(), ignoreCase: z.boolean().default(false) }).strict(),
	z.object({ ...base, type: z.literal("max_model_calls"), value: z.number().int().min(1) }).strict(),
	z.object({ ...base, type: z.literal("max_discards"), value: z.number().int().min(0) }).strict(),
	z.object({ ...base, type: z.literal("language"), value: z.enum(LANGUAGES) }).strict(),
	z.object({ ...base, type: z.literal("no_internals"), extraTerms: z.array(z.string()).default([]) }).strict(),
	z.object({ ...base, type: z.literal("file_created"), extension: z.string().optional() }).strict(),
	z.object({ ...base, type: z.literal("chart"), spec: argPredicates.optional() }).strict(),
	z.object({ ...base, type: z.literal("no_unfulfilled_promise") }).strict(),
	z.object({ ...base, type: z.literal("no_model_note"), pattern: z.string() }).strict(),
	z.object({ ...base, type: z.literal("steer_delivered") }).strict(),
	z.object({ ...base, type: z.literal("completed") }).strict(),
	/** Juiz LLM (opcional, desligado por padrão): só roda com `--judge <modelo>`. */
	z.object({ ...base, type: z.literal("judge"), rubric: z.string().min(10) }).strict(),
]);
export type Expectation = z.infer<typeof expectation>;

export const scenarioSchema = z
	.object({
		version: z.literal(SCENARIO_VERSION),
		id: z.string().regex(/^[a-z0-9-]+$/),
		title: z.string().min(1),
		description: z.string().optional(),
		tags: z.array(z.string()).default([]),
		source: z.object({ kind: z.enum(["seed", "production"]), runId: z.string().optional(), note: z.string().optional() }).strict().default({ kind: "seed" }),
		bot: z.object({ name: z.string().min(1), about: z.string().default(""), language: z.enum(LANGUAGES).default("pt-BR") }).strict(),
		history: z.array(historyMessage).default([]),
		user: z.string().min(1),
		/** Mensagem do usuário que chega no meio do run, depois de N chamadas ao modelo. */
		steer: z.array(z.object({ afterModelCalls: z.number().int().min(1), content: z.string().min(1) }).strict()).default([]),
		tools: z
			.object({
				fixtures: z.array(nativeFixture).default([]),
				connectors: z.array(connector).default([]),
				/** Tools nativas extras que podem rodar de verdade (sem rede nem banco). */
				allowReal: z.array(z.string()).default([]),
			})
			.strict()
			.default({ fixtures: [], connectors: [], allowReal: [] }),
		run: z.object({ maxSteps: z.number().int().min(1).max(40).default(8), origin: z.string().default("chat") }).strict().default({ maxSteps: 8, origin: "chat" }),
		expect: z.array(expectation).min(1),
		/** Roteiro do modelo falso (modo mock/CI): valida o harness, não o modelo. */
		mock: z.object({ turns: z.array(mockTurn).min(1), cheapAnswer: z.string().optional() }).strict().optional(),
	})
	.strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;

export type ScenarioParse = { ok: true; scenario: Scenario } | { ok: false; error: string };

/** Valida um cenário; o erro lista caminho e motivo de cada problema. */
export function parseScenario(input: unknown): ScenarioParse {
	const parsed = scenarioSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`).join("; ") };
	}
	const scenario = parsed.data;
	for (const item of scenario.expect) {
		if ((item.type === "tool_called" || item.type === "tool_not_called") && !item.tool && !item.toolPattern) return { ok: false, error: `expect: ${item.type} precisa de tool ou toolPattern` };
		if ((item.type === "text_contains" || item.type === "text_not_contains") && !item.value && !item.pattern) return { ok: false, error: `expect: ${item.type} precisa de value ou pattern` };
	}
	const ids = scenario.expect.map(expectationName);
	const duplicate = ids.find((name, index) => ids.indexOf(name) !== index);
	if (duplicate) return { ok: false, error: `expect: nome repetido "${duplicate}" (dê um id a cada verificação)` };
	return { ok: true, scenario };
}

/** Nome estável da verificação no relatório. */
export function expectationName(item: Expectation): string {
	if (item.id) return item.id;
	if (item.type === "tool_called" || item.type === "tool_not_called") return `${item.type}:${item.tool ?? item.toolPattern}`;
	if (item.type === "file_created" && item.extension) return `file_created:${item.extension}`;
	if (item.type === "language") return `language:${item.value}`;
	return item.type;
}

/** Lê todos os `*.json` de um diretório (ordem alfabética). Falha com o arquivo e o motivo. */
export async function loadScenarios(dir: string): Promise<Scenario[]> {
	const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
	const out: Scenario[] = [];
	for (const file of files) {
		const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as unknown;
		const parsed = parseScenario(raw);
		if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
		out.push(parsed.scenario);
	}
	const ids = out.map((scenario) => scenario.id);
	const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
	if (duplicate) throw new Error(`cenário repetido: ${duplicate}`);
	return out;
}

/** Filtra por `all` ou lista de ids/tags separados por vírgula. */
export function selectScenarios(all: Scenario[], selector: string): Scenario[] {
	if (!selector || selector === "all") return all;
	const wanted = new Set(selector.split(",").map((item) => item.trim()).filter(Boolean));
	const picked = all.filter((scenario) => wanted.has(scenario.id) || scenario.tags.some((tag) => wanted.has(tag)));
	const unknown = [...wanted].filter((item) => !all.some((scenario) => scenario.id === item || scenario.tags.includes(item)));
	if (unknown.length > 0) throw new Error(`cenário ou tag desconhecido: ${unknown.join(", ")}`);
	return picked;
}
