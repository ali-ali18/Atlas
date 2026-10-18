import type { McpToolset } from "../mcp/registry.js";
import { clipForJev, decideWithJev, jevModeFor, jevYes, type JevRuntime } from "./decide.js";

export const JEV_PRESELECT_MAX_TOOLS = 8;
const MAX_CANDIDATES = 60;
const THRESHOLD = 0.6;

/**
 * Quais tools de LEITURA do índice o pedido provavelmente precisa. Devolve nomes
 * expostos, do mais provável ao menos, para ativar pelo caminho normal
 * (autonomia/orçamento/`toolFilter` continuam valendo no chamador).
 */
export async function preselectMcpTools(input: {
	rt: JevRuntime | undefined;
	userRequest: string;
	toolset: Pick<McpToolset, "index" | "deferred">;
	isAllowed: (exposedName: string) => boolean;
	max?: number;
	signal?: AbortSignal;
}): Promise<string[]> {
	const mode = jevModeFor(input.rt, "tools");
	const request = input.userRequest.trim();
	if (mode === "off" || !request || !input.toolset.deferred) return [];
	const candidates: Array<{ name: string; line: string }> = [];
	for (const connector of input.toolset.index) {
		for (const tool of connector.tools) {
			if (!tool.readOnly || !input.isAllowed(tool.name)) continue;
			candidates.push({ name: tool.name, line: `${connector.connectorName}: ${tool.toolName} - ${tool.summary}` });
			if (candidates.length >= MAX_CANDIDATES) break;
		}
		if (candidates.length >= MAX_CANDIDATES) break;
	}
	if (candidates.length === 0) return [];
	const questions = Object.fromEntries(
		candidates.map((candidate, index) => [
			`t${index}`,
			{
				instructions: `Is this connector tool likely needed to fulfil the user's request? Tool: ${clipForJev(candidate.line, 200)}`,
				criteria: { true: "The request needs this tool", false: "The request does not need this tool" },
			},
		]),
	);
	const result = await decideWithJev({
		rt: input.rt,
		feature: "tools",
		state: { userRequest: clipForJev(request, 1_500) },
		questions,
		signal: input.signal,
	});
	if (!result || mode !== "on") return [];
	return candidates
		.map((candidate, index) => ({ name: candidate.name, p: result.answers[`t${index}`] ?? 0 }))
		.filter((item) => jevYes(item.p, THRESHOLD))
		.sort((a, b) => b.p - a.p)
		.slice(0, input.max ?? JEV_PRESELECT_MAX_TOOLS)
		.map((item) => item.name);
}
