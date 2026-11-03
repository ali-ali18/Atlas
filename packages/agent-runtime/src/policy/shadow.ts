import { autonomyExceptionMode, type EffectiveAutonomy } from "@workspace/shared";
import type { McpToolEntry } from "../mcp/registry.js";
import { explainDecision, humanPresentFor, type PolicyContext, type PolicyDecision, type PolicyTool } from "./decide.js";
import { mcpPolicyTool, nativePolicyTool } from "./tool.js";

/**
 * Modo sombra da política (PR2 do harness v3): o v2 continua decidindo como sempre; aqui só se calcula o que
 * `decide` diria e se registra a divergência. Nenhuma função daqui altera decisão, lança erro ou toca em args:
 * o log leva só tool, origem e as duas decisões (sem argumentos, sem texto do usuário). O PR11 troca a decisão
 * real pela da política; até lá, a tabela de divergências conhecidas está no relato do PR2.
 */

export type ShadowStage = "catalog" | "execute";
/** No catálogo só existe visível/oculto; na execução, as quatro decisões. */
export type ShadowValue = PolicyDecision | "visible" | "hidden";

export type PolicyDivergence = {
	event: "policy_shadow_divergence";
	stage: ShadowStage;
	tool: string;
	origin: string;
	current: ShadowValue;
	next: ShadowValue;
	reason: string;
};

export type ShadowSink = (divergence: PolicyDivergence) => void;

const defaultSink: ShadowSink = (divergence) => console.info(JSON.stringify(divergence));
let sink: ShadowSink = defaultSink;
const seen = new Set<string>();
const SEEN_MAX = 2000;

/** Troca o destino do log (testes). Devolve a função que restaura o anterior e limpa o dedupe. */
export function setPolicyShadowSink(next: ShadowSink): () => void {
	const previous = sink;
	sink = next;
	seen.clear();
	return () => {
		sink = previous;
		seen.clear();
	};
}

export function policyShadowEnabled(): boolean {
	return process.env.ATLAS_POLICY_SHADOW !== "0";
}

function report(divergence: PolicyDivergence): void {
	// A mesma divergência se repete a cada run: loga uma vez por processo (o log serve para achar regra, não para contar).
	const key = `${divergence.stage}|${divergence.origin}|${divergence.tool}|${divergence.current}|${divergence.next}`;
	if (seen.has(key)) return;
	if (seen.size >= SEEN_MAX) seen.clear();
	seen.add(key);
	try {
		sink(divergence);
	} catch {
		// log nunca derruba o run
	}
}

function levelOf(autonomy: EffectiveAutonomy): PolicyContext["autonomy"] {
	return autonomy.level;
}

function baseContext(input: { origin: string; parentOrigin?: string; autonomy: EffectiveAutonomy; planPending?: boolean }): PolicyContext {
	return {
		origin: input.origin,
		...(input.parentOrigin ? { parentOrigin: input.parentOrigin } : {}),
		humanPresent: humanPresentFor(input.origin, input.parentOrigin),
		autonomy: levelOf(input.autonomy),
		planPending: input.planPending === true,
	};
}

/**
 * Montagem do catálogo: confere a visibilidade que o v2 decidiu. `nativeExposed` são as tools nativas que o v2
 * mostrou; `mcp` traz cada tool de conector com o que o v2 decidiu (`visible`). Para nativa só se compara
 * "mostrada mas a política esconderia"; para conector, nos dois sentidos.
 */
export function shadowCatalog(input: {
	origin: string;
	parentOrigin?: string;
	autonomy: EffectiveAutonomy;
	nativeExposed: readonly string[];
	mcp: ReadonlyArray<{ name: string; entry: McpToolEntry; visible: boolean }>;
}): void {
	if (!policyShadowEnabled()) return;
	try {
		const ctx = baseContext(input);
		const compare = (tool: PolicyTool, currentVisible: boolean, userRules?: PolicyContext["userRules"], onlyHideDivergence = false) => {
			const verdict = explainDecision(tool, { ...ctx, ...(userRules ? { userRules } : {}) });
			const nextVisible = verdict.decision !== "hide";
			if (nextVisible === currentVisible) return;
			if (onlyHideDivergence && !currentVisible) return;
			report({
				event: "policy_shadow_divergence",
				stage: "catalog",
				tool: tool.name,
				origin: input.origin,
				current: currentVisible ? "visible" : "hidden",
				next: nextVisible ? "visible" : "hidden",
				reason: verdict.reason,
			});
		};
		for (const name of input.nativeExposed) {
			const tool = nativePolicyTool(name);
			if (tool) compare(tool, true);
		}
		for (const item of input.mcp) {
			const mode = autonomyExceptionMode(input.autonomy, item.entry.autonomyMeta);
			compare(mcpPolicyTool(item.name, item.entry), item.visible, mode ? { mode } : undefined);
		}
	} catch {
		// a sombra nunca altera o run
	}
}

/** Antes de executar: compara a decisão que o v2 vai tomar com a da política, já com os args desta chamada. */
export function shadowExecute(input: {
	name: string;
	args: Record<string, unknown>;
	entry?: McpToolEntry;
	origin: string;
	parentOrigin?: string;
	autonomy: EffectiveAutonomy;
	planPending?: boolean;
	forceConfirm?: boolean;
	/** Decisão que o v2 vai aplicar (já traduzida: `block`→`deny`). */
	current: PolicyDecision;
}): void {
	if (!policyShadowEnabled()) return;
	try {
		const tool = input.entry ? mcpPolicyTool(input.name, input.entry) : nativePolicyTool(input.name, input.args);
		if (!tool) return;
		const mode = input.entry ? autonomyExceptionMode(input.autonomy, input.entry.autonomyMeta) : undefined;
		const userRules = { ...(mode ? { mode } : {}), ...(input.forceConfirm ? { confirmAlways: true } : {}) };
		const verdict = explainDecision(tool, { ...baseContext(input), userRules, stage: "execute" });
		if (verdict.decision === input.current) return;
		report({ event: "policy_shadow_divergence", stage: "execute", tool: input.name, origin: input.origin, current: input.current, next: verdict.decision, reason: verdict.reason });
	} catch {
		// a sombra nunca altera o run
	}
}
