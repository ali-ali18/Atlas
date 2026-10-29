import { createRedactor } from "./redact.js";
import { parseScenario, SCENARIO_VERSION, type ScenarioBotLanguage, type ScenarioInput } from "./scenario.js";

/**
 * Run de produção → cenário. Entrada: o JSON de `GET /v1/runs/:id/inspect` (de preferência com o inspetor completo,
 * `ATLAS_RUN_INSPECTOR_FULL=1`, que traz o pedido enviado ao modelo) e, opcional, o de `GET /v1/runs/:id/events`
 * (resultados de tool inteiros). Saída: cenário com os resultados de tool congelados como fixtures e os dados
 * pessoais e segredos redigidos. As expectativas ficam por conta do dono (só `completed` vem pronto).
 */

type Row = { role?: string; content?: unknown; tool_calls?: Array<{ id?: string; name?: string; arguments?: string; function?: { name?: string; arguments?: string } }>; tool_call_id?: string };
type ToolUse = { id: string; name: string; args: Record<string, unknown>; ok: boolean; summary: string };

export type FromRunInput = {
	inspect: unknown;
	events?: unknown;
	/** Texto do pedido quando o inspetor não trouxe o pedido completo. */
	user?: string;
	id?: string;
	language?: ScenarioBotLanguage;
	botName?: string;
};

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value));

function parseArgs(raw: unknown): Record<string, unknown> {
	if (record(raw)) return record(raw)!;
	try {
		return record(JSON.parse(String(raw ?? "{}"))) ?? {};
	} catch {
		return {};
	}
}

/** Mensagens do 1º passo do inspetor completo (`steps[].request.text` = JSON `{tools, messages}`). */
function firstRequestRows(inspection: Record<string, unknown>): Row[] {
	const steps = Array.isArray(inspection.steps) ? inspection.steps : [];
	for (const step of steps) {
		const request = record(record(step)?.request);
		if (typeof request?.text !== "string") continue;
		try {
			const parsed = JSON.parse(request.text) as { messages?: Row[] };
			if (Array.isArray(parsed.messages)) return parsed.messages;
		} catch {
			// pedido truncado ou inválido: tenta o próximo passo
		}
	}
	return [];
}

/** Chamadas de tool do run: eventos (resultado inteiro) com reserva no resumo truncado do inspetor. */
function toolUses(inspection: Record<string, unknown>, events: unknown): ToolUse[] {
	const list = Array.isArray(record(events)?.events) ? (record(events)!.events as unknown[]) : Array.isArray(events) ? events : [];
	const payloads = list.map((row) => record(record(row)?.payload) ?? record(row)).filter((item): item is Record<string, unknown> => !!item);
	const calls = new Map<string, ToolUse>();
	for (const payload of payloads) {
		if (payload.type === "tool_call" && typeof payload.id === "string") calls.set(payload.id, { id: payload.id, name: String(payload.name), args: parseArgs(payload.args), ok: true, summary: "" });
		if (payload.type === "tool_result" && typeof payload.id === "string") {
			const call = calls.get(payload.id) ?? { id: payload.id, name: String(payload.name), args: {}, ok: true, summary: "" };
			calls.set(payload.id, { ...call, ok: Boolean(payload.ok), summary: text(payload.summary) });
		}
	}
	if (calls.size > 0) return [...calls.values()];
	const fromInspect = Array.isArray(inspection.toolCalls) ? inspection.toolCalls : [];
	return fromInspect
		.map((item) => record(item))
		.filter((item): item is Record<string, unknown> => !!item)
		.map((item) => ({ id: String(item.id), name: String(item.name), args: parseArgs(item.args), ok: item.status !== "failed", summary: text(item.summary) }));
}

function schemaFromArgs(uses: ToolUse[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	for (const use of uses) {
		for (const [key, value] of Object.entries(use.args)) {
			properties[key] ??= { type: Array.isArray(value) ? "array" : value === null ? "string" : typeof value === "object" ? "object" : typeof value };
		}
	}
	return { type: "object", properties };
}

/** Predicados `equals` dos argumentos de topo, só quando a mesma tool foi chamada com argumentos diferentes. */
function argsKey(uses: ToolUse[], use: ToolUse): Record<string, { equals: unknown }> | undefined {
	const distinct = new Set(uses.map((item) => JSON.stringify(item.args)));
	if (distinct.size <= 1) return undefined;
	return Object.fromEntries(Object.entries(use.args).map(([key, value]) => [key, { equals: value }]));
}

export function scenarioFromRun(input: FromRunInput): { scenario: ScenarioInput; redactions: Record<string, number> } {
	const inspection = record(record(input.inspect)?.inspection) ?? record(input.inspect);
	if (!inspection || !Array.isArray(inspection.steps)) throw new Error("JSON do inspetor inválido: esperado o corpo de GET /v1/runs/:id/inspect");
	const runId = typeof inspection.runId === "string" ? inspection.runId : "desconhecido";
	const rows = firstRequestRows(inspection).filter((row) => row.role !== "system");
	const lastUser = rows.map((row) => row.role).lastIndexOf("user");
	const user = input.user ?? (lastUser >= 0 ? text(rows[lastUser]!.content) : "");
	if (!user.trim()) throw new Error("sem o pedido do usuário: ligue ATLAS_RUN_INSPECTOR_FULL=1 no worker ou passe --user \"<texto>\"");
	const history = (lastUser >= 0 ? rows.slice(0, lastUser) : [])
		.map((row): NonNullable<ScenarioInput["history"]>[number] | null => {
			if (row.role === "tool" && row.tool_call_id) return { role: "tool", toolCallId: row.tool_call_id, content: text(row.content) };
			if (row.role === "assistant" && row.tool_calls?.length) {
				return {
					role: "assistant",
					content: row.content === undefined ? null : text(row.content),
					toolCalls: row.tool_calls.map((call, index) => ({ id: call.id ?? `hist_${index}`, name: call.name ?? call.function?.name ?? "unknown", args: parseArgs(call.arguments ?? call.function?.arguments) })),
				};
			}
			if (row.role === "user" || row.role === "assistant") return { role: row.role, content: text(row.content) };
			return null;
		})
		.filter((row): row is NonNullable<typeof row> => row !== null);

	const uses = toolUses(inspection, input.events);
	const native = uses.filter((use) => !use.name.startsWith("mcp__"));
	const byConnector = new Map<string, Map<string, ToolUse[]>>();
	for (const use of uses.filter((item) => item.name.startsWith("mcp__"))) {
		const [, slug = "conector", ...rest] = use.name.split("__");
		const tool = rest.join("__") || "tool";
		const tools = byConnector.get(slug) ?? new Map<string, ToolUse[]>();
		tools.set(tool, [...(tools.get(tool) ?? []), use]);
		byConnector.set(slug, tools);
	}
	const connectors = [...byConnector].map(([slug, tools]) => ({
		slug: slug.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
		name: slug,
		preload: true,
		tools: [...tools].map(([name, list]) => ({
			name,
			description: `${name} (congelado do run ${runId}; ajuste a descrição)`,
			inputSchema: schemaFromArgs(list),
			readOnly: /^(get|list|search|find|read|fetch|query|describe)/i.test(name),
			responses: list.map((use) => {
				const args = argsKey(list, use);
				return { ...(args ? { args } : {}), ok: use.ok, text: use.summary };
			}),
		})),
	}));
	const fixtures = native.map((use) => {
		const args = argsKey(native.filter((item) => item.name === use.name), use);
		return { tool: use.name, ...(args ? { args } : {}), result: { ok: use.ok, summary: use.summary } };
	});

	const redactor = createRedactor();
	const finalText = text(record(record(input.events)?.run)?.resultText);
	const scenario: ScenarioInput = redactor.deep({
		version: SCENARIO_VERSION,
		id: input.id ?? `producao-${runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "run"}`,
		title: `Run de produção ${runId}: descreva o comportamento esperado`,
		description: finalText ? `Resposta em produção (redigida): ${finalText.slice(0, 600)}` : "Adicione o que deu errado e o comportamento esperado.",
		tags: ["producao"],
		source: { kind: "production", runId, note: "Gerado por from-run; dados pessoais e segredos redigidos por padrão. Revise antes de commitar." },
		bot: { name: input.botName ?? "Bot", about: "", language: input.language ?? "pt-BR" },
		history,
		user,
		tools: { fixtures, connectors, allowReal: [] },
		expect: [{ type: "completed" }],
	});
	const parsed = parseScenario(scenario);
	if (!parsed.ok) throw new Error(`cenário gerado inválido: ${parsed.error}`);
	return { scenario, redactions: redactor.counts() };
}
