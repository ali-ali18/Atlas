import type { ChatTool } from "@workspace/llm";
import { describe, expect, it } from "vitest";
import { COMPUTER_USE_TOOLS } from "../../computer-use.js";
import { isReadOnlyToolName } from "../../execution/run-governor.js";
import { DEV_SESSION_TOOL_NAMES } from "../dev-session.js";
import { getResolvedDefinedTool, getToolMeta, getToolRegistration, listRegisteredToolNames, resolveToolEffect } from "./index.js";

/**
 * Retrato do catálogo nativo INTEIRO (PR5b do harness v3): nome, descrição, schema, grupo, readOnly e metadado de
 * cada tool. Foi tirado ANTES da migração para `defineTool`; cada commit da migração bateu com ele sem atualizar o
 * arquivo (v1/v2/v3 idênticos). Mudou de propósito? Rode `vitest -u` e explique no commit.
 * A definição de cada tool vem da própria tool (`defineTool`/`defineRawTool`): do registro ou, na sessão de código, do resolvedor.
 */

/** Args de amostra para as tools que refinam o efeito por chamada. */
const EFFECT_SAMPLES: Record<string, Array<Record<string, unknown>>> = {
	sandbox_download: [{}, { use_browser_session: false }, { use_browser_session: true }, { url: "https://x.test" }],
	api_call: [{}, { operationId: "list" }, { method: "GET" }, { method: " head " }, { method: "POST" }, { method: "delete" }, { method: 7 }],
};

function definitionOf(name: string): ChatTool | undefined {
	return getToolRegistration(name)?.definition ?? getResolvedDefinedTool(name)?.definition;
}

function describeTool(name: string, dev: boolean) {
	const registration = getToolRegistration(name);
	const meta = dev ? getToolMeta(name) : (registration ?? undefined);
	const effectAt = (args: Record<string, unknown>) => resolveToolEffect(name, args) ?? null;
	return {
		name,
		group: dev ? "dev" : (registration?.group ?? null),
		source: dev ? "dev-session" : "registry",
		readOnly: dev ? isReadOnlyToolName(name, () => false) : (registration?.readOnly ?? null),
		definition: definitionOf(name) ?? null,
		effect: meta?.effect ?? null,
		catalogEffect: meta?.catalogEffect ?? null,
		poll: meta?.poll ?? null,
		endsTurn: meta?.endsTurn ?? null,
		needsHuman: meta?.needsHuman ?? null,
		ownCard: meta?.ownCard ?? null,
		effectBySample: (EFFECT_SAMPLES[name] ?? []).map((args) => ({ args, effect: effectAt(args) })),
	};
}

describe("retrato do catálogo nativo", () => {
	it("cada tool nativa mantém nome, descrição, schema, grupo e metadado", async () => {
		const registryNames = [...listRegisteredToolNames()].sort();
		const devNames = [...DEV_SESSION_TOOL_NAMES].sort();
		const snapshot = {
			catalogOrder: COMPUTER_USE_TOOLS.map((tool) => tool.function.name),
			tools: [...registryNames.map((name) => describeTool(name, false)), ...devNames.map((name) => describeTool(name, true))],
		};
		await expect(JSON.stringify(snapshot, null, 1) + "\n").toMatchFileSnapshot("./__snapshots__/tool-catalog.snap.json");
		expect(snapshot.tools.length).toBe(registryNames.length + devNames.length);
	});
});
