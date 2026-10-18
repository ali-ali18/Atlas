import type { ChatTool } from "@workspace/llm";
import { NATIVE_TOOL_GROUPS, type DeferredNativeTool, type NativeToolGroup } from "./native-tools.js";
import { groupProcedureText, type ContextGroup } from "./prompt-blocks.js";

/**
 * Carregamento sob demanda das tools nativas adiadas (L5). Uma tool carregada no
 * meio do run entra no FIM do array de tools (nada reordena o que já foi
 * enviado, então o prefixo em cache aguenta) e traz, no resultado, o
 * procedimento do grupo que não estava no prompt.
 */
export type NativeMatch = {
	names: string[];
	/** Nome exato de tool ou nome de grupo na consulta (vence uma busca de conector). */
	strong: boolean;
};

export type NativeDeferral = {
	isDeferred(name: string): boolean;
	/** Nomes adiados que casam com a consulta (nome exato, grupo ou necessidade). */
	match(query: string, limit: number): NativeMatch;
	/** Carrega (acrescenta ao fim de `tools`) e devolve só o que mudou. */
	load(names: readonly string[]): { loaded: string[]; notes: string };
	/** Carrega a tool e as irmãs do mesmo grupo (chamada direta a tool não carregada). */
	loadGroupOf(name: string): { loaded: string[]; notes: string };
	/** Nomes ainda adiados (para mensagens de erro e testes). */
	pending(): string[];
};

function tokenize(text: string): string[] {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 3);
}

export function createNativeDeferral(input: {
	/** Pool mutável: o que carrega sai dele. */
	deferred: Map<string, DeferredNativeTool>;
	/** Array de tools do run (mesma referência enviada ao modelo). */
	tools: ChatTool[];
	/** Grupos cujo procedimento já está no prompt (mutável). */
	promptedGroups: Set<ContextGroup>;
}): NativeDeferral {
	const { deferred, tools, promptedGroups } = input;
	const membersOf = (group: NativeToolGroup) =>
		[...deferred.entries()].filter(([, entry]) => entry.group === group).map(([name]) => name);
	const api: NativeDeferral = {
		isDeferred: (name) => deferred.has(name),
		pending: () => [...deferred.keys()],
		match(query, limit) {
			const terms = new Set(
				query
					.split(/[\s,]+/)
					.map((term) => term.trim().toLowerCase())
					.filter(Boolean),
			);
			if (terms.size === 0 || deferred.size === 0) return { names: [], strong: false };
			const exact = [...deferred.keys()].filter((name) => terms.has(name.toLowerCase()));
			if (exact.length > 0) return { names: exact.slice(0, limit), strong: true };
			// Grupo por nome ou por palavra distintiva: carrega o grupo inteiro (poucas tools coesas).
			const queryTokens = new Set(tokenize(query));
			const scored: Array<{ group: NativeToolGroup; score: number; named: boolean }> = [];
			for (const group of Object.keys(NATIVE_TOOL_GROUPS) as NativeToolGroup[]) {
				if (membersOf(group).length === 0) continue;
				const named = terms.has(group);
				let score = named ? 10 : 0;
				for (const keyword of NATIVE_TOOL_GROUPS[group].keywords) {
					if (queryTokens.has(keyword)) score += 1;
				}
				if (score > 0) scored.push({ group, score, named });
			}
			scored.sort((a, b) => b.score - a.score);
			const names: string[] = [];
			for (const { group } of scored) {
				const members = membersOf(group);
				if (names.length > 0 && names.length + members.length > limit) break;
				names.push(...members);
			}
			return { names, strong: scored.some((entry) => entry.named) };
		},
		loadGroupOf(name) {
			const group = deferred.get(name)?.group;
			if (!group) return { loaded: [], notes: "" };
			return api.load(membersOf(group));
		},
		load(names) {
			const loaded: string[] = [];
			const newGroups = new Set<ContextGroup>();
			for (const name of names) {
				const entry = deferred.get(name);
				if (!entry) continue;
				tools.push(entry.tool);
				deferred.delete(name);
				loaded.push(name);
				if (!promptedGroups.has(entry.group)) newGroups.add(entry.group);
			}
			for (const group of newGroups) promptedGroups.add(group);
			const procedure = groupProcedureText(newGroups);
			return { loaded, notes: procedure ? `Usage notes for the loaded tools:\n${procedure}` : "" };
		},
	};
	return api;
}
