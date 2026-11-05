import { buildMcpToolset, type McpRuntime, type runComputerUse } from "@workspace/agent-runtime";
import { argsMatch } from "./predicates.js";
import type { NativeFixture, Scenario } from "./scenario.js";
import type { RecordedToolResult } from "./trajectory.js";

/**
 * Ambiente falso de um cenário: perfil do bot fixo, tools nativas respondidas pelos fixtures, conectores falsos e
 * `create_file` em memória. Nada sai para rede ou banco. A interceptação usa o gancho de replay do runtime
 * (`findCompletedTool`), chamado logo depois do evento `tool_call` e antes do executor: o modelo vê o resultado do
 * fixture como se a tool tivesse rodado.
 */

type RunParams = Parameters<typeof runComputerUse>[0];

/** Tools nativas que rodam de verdade no eval (puras, sem rede nem banco; `create_file` com armazenamento em memória). */
export const REAL_NATIVE_TOOLS = ["track_items", "update_task_list", "create_file", "mcp_tool_search", "read_cached_result", "skill_read", "list_skills", "show_skill"] as const;

/**
 * Loja de skills em memória: sem skill do dono (lista vazia) e sem escrita. `skill_read` cai então nas skills de
 * fábrica reais (`skills/builtin/*.md`), o mesmo texto que o bot lê em produção, sem tocar o banco. Escrita
 * (`propose_skill`/`delete_skill`) segue sem fixture: o eval não grava skill.
 */
export function memorySkillsStore(): NonNullable<RunParams["skillStore"]> {
	return {
		listAll: async () => [],
		readActive: async () => null,
		apply: async () => {
			throw new Error("skills são somente leitura no eval");
		},
	};
}

/** Resposta neutra para tool sem fixture: o modelo segue sem inventar, e a matriz aponta a lacuna do cenário. */
export const UNMOCKED_SUMMARY = "This tool is unavailable right now. Continue with the information you already have, or tell the user what you could not do.";

export const EVAL_USER_ID = "eval-user";
export const EVAL_BOT_ID = "eval-bot";

export type ScenarioEnvironment = {
	params: Pick<RunParams, "loadBotProfile" | "findCompletedTool" | "mcp" | "forcedConnectors" | "createFileDeps" | "skillStore" | "language">;
	/** Alimentado com cada evento do run (precisa ver o `tool_call` antes do replay). */
	observe: (event: Record<string, unknown>) => void;
	/** Origem do resultado de cada chamada (fixture, conector, execução real ou sem fixture). */
	sourceOf: (callId: string, name: string) => RecordedToolResult["source"];
	unmocked: string[];
};

/** Id da chamada dentro da chave de idempotência `${runId}:${decisionIndex}:${toolCallId}:${toolName}`. */
export function callIdFromKey(key: string, known: Iterable<string>): string | undefined {
	for (const id of known) if (key.endsWith(`:${id}:${key.slice(key.lastIndexOf(":") + 1)}`)) return id;
	return undefined;
}

export function connectorToolName(slug: string, tool: string): string {
	return `mcp__${slug}__${tool}`;
}

function buildConnectors(scenario: Scenario): McpRuntime | null {
	if (scenario.tools.connectors.length === 0) return null;
	const connections = scenario.tools.connectors.map((connector) => ({
		id: `conn-${connector.slug}`,
		slug: connector.slug,
		name: connector.name,
		disabledTools: [],
		tools: connector.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
		})),
	}));
	const responders = new Map(scenario.tools.connectors.flatMap((connector) => connector.tools.map((tool) => [connectorToolName(connector.slug, tool.name), tool.responses] as const)));
	return {
		toolset: buildMcpToolset(connections),
		call: async (exposedName, args) => {
			const response = responders.get(exposedName)?.find((item) => argsMatch(args, item.args));
			if (!response) return { ok: false, text: "No data for these arguments.", truncated: false };
			return { ok: response.ok, text: response.text, truncated: false };
		},
	};
}

function memoryFileDeps(): NonNullable<RunParams["createFileDeps"]> {
	let count = 0;
	return {
		persist: async (input) => {
			count += 1;
			return { id: `art-eval-${count}`, kind: input.kind, meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength }, runId: input.runId ?? null, conversationId: null, createdAt: new Date(0) };
		},
		nextVersion: async () => 1,
		countRunFiles: async () => count,
		printPdf: async () => new TextEncoder().encode("%PDF-1.4 eval"),
		runPython: async () => {
			throw new Error("sandbox indisponível no eval");
		},
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * URLs de uma chamada que lê em lote (`urls: string[]`, schema real do `web_extract`). Os fixtures dos cenários
 * casam por `url`; sem esta ponte, o modelo real (que manda `urls`) recebia "indisponível" e o eval culpava o motor.
 */
export function listedUrls(args: unknown): string[] | null {
	if (!isRecord(args) || !Array.isArray(args.urls)) return null;
	const urls = args.urls.filter((item): item is string => typeof item === "string");
	return urls.length > 0 ? urls : null;
}

/**
 * Resposta neutra para tools de consulta que o modelo real chama por conta própria (memória, histórico, hora).
 * Sem isso elas voltavam "indisponível", o modelo desviava e o eval culpava o motor. Fixture do cenário vence.
 * A hora é fixa (quinta, 05/11/2026 10:00 em São Paulo): o eval nunca depende do relógio real.
 */
export const EVAL_NOW_TEXT = "2026-11-05T10:00:00-03:00 (Thursday, America/Sao_Paulo)";
export function neutralResult(name: string, args: unknown): { ok: boolean; summary: string } | null {
	if (name === "memory_search" || name === "session_search") return { ok: true, summary: "No results." };
	if (name === "current_time") return { ok: true, summary: EVAL_NOW_TEXT };
	if (name === "memory") {
		const action = isRecord(args) ? args.action : undefined;
		return { ok: true, summary: action === "list" || action === undefined ? "No saved memories." : "Saved." };
	}
	return null;
}

export function buildEnvironment(scenario: Scenario): ScenarioEnvironment {
	const calls = new Map<string, { name: string; args: unknown }>();
	const sources = new Map<string, RecordedToolResult["source"]>();
	const unmocked: string[] = [];
	const fixtureUses = new Map<NativeFixture, number>();
	/** A mesma chamada pode ser consultada mais de uma vez: ela consome o fixture uma vez só. */
	const assigned = new Map<string, NativeFixture>();
	const real = new Set<string>([...REAL_NATIVE_TOOLS, ...scenario.tools.allowReal]);
	const mcp = buildConnectors(scenario);
	const preload = scenario.tools.connectors.filter((connector) => connector.preload).map((connector) => connector.slug);
	return {
		params: {
			language: scenario.bot.language,
			loadBotProfile: async () => ({ name: scenario.bot.name, snippet: "", description: scenario.bot.about || null, openRouterModel: null, language: scenario.bot.language }),
			findCompletedTool: async (key) => {
				const id = callIdFromKey(key, calls.keys());
				const call = id ? calls.get(id) : undefined;
				if (!id || !call || call.name.startsWith("mcp__")) return null;
				const urls = listedUrls(call.args);
				if (!assigned.has(id) && urls && urls.length > 1) {
					// Leitura em lote (`urls: [...]`, como o schema real do web_extract): cada URL responde pelo seu fixture.
					const parts = urls.map((url) => scenario.tools.fixtures.find((item) => item.tool === call.name && argsMatch({ url, urls: [url] }, item.args)));
					if (parts.some(Boolean)) {
						sources.set(id, "fixture");
						const summary = urls.map((url, index) => parts[index]?.result.summary ?? `${url}: error (not found)`).join("\n\n");
						return { ok: parts.some((part) => part?.result.ok), summary };
					}
				}
				const matchArgs = urls && urls.length === 1 && isRecord(call.args) ? { ...call.args, url: urls[0] } : call.args;
				const fixture =
					assigned.get(id) ?? scenario.tools.fixtures.find((item) => item.tool === call.name && argsMatch(matchArgs, item.args) && (item.uses === undefined || (fixtureUses.get(item) ?? 0) < item.uses));
				if (fixture) {
					if (!assigned.has(id)) {
						assigned.set(id, fixture);
						fixtureUses.set(fixture, (fixtureUses.get(fixture) ?? 0) + 1);
					}
					sources.set(id, "fixture");
					return { ok: fixture.result.ok, summary: fixture.result.summary };
				}
				if (real.has(call.name)) return null;
				const neutral = neutralResult(call.name, call.args);
				if (neutral) {
					sources.set(id, "fixture");
					return neutral;
				}
				sources.set(id, "unmocked");
				unmocked.push(call.name);
				return { ok: false, summary: UNMOCKED_SUMMARY };
			},
			mcp,
			...(preload.length > 0 ? { forcedConnectors: preload } : {}),
			createFileDeps: memoryFileDeps(),
			skillStore: memorySkillsStore(),
		},
		observe: (event) => {
			if (event.type !== "tool_call" || typeof event.id !== "string") return;
			let args: unknown = {};
			try {
				args = JSON.parse(String(event.args ?? "{}")) as unknown;
			} catch {
				args = {};
			}
			calls.set(event.id, { name: String(event.name), args });
		},
		sourceOf: (callId, name) => sources.get(callId) ?? (name.startsWith("mcp__") ? "connector" : "real"),
		unmocked,
	};
}
