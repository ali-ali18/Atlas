import type { HandoffKind } from "@workspace/shared";
import { z } from "zod";
import { EFFECT_CLASSES, type Effect, isEffect } from "../contract/effects.js";
import { OWNER_DATA_KINDS, type OwnerDataKind, type TrustSource } from "../contract/provenance.js";
import type { LlmToolSpec } from "../ports/llm.js";
import { inputJsonSchema, toLlmToolSpec } from "./tool-json-schema.js";
import type { RiskFacts, ToolContext, ToolResult } from "./types.js";

export type ToolDefinition<S extends z.ZodObject> = {
	/** snake_case, único no registro. */
	name: string;
	/** Texto para o MODELO (inglês, curto): o que faz, quando usar e quando não usar. */
	description: string;
	inputSchema: S;
	/** Obrigatório. Classe de efeito declarada pela tool, nunca pelo modelo. */
	effect: Effect;
	/** Efeito que depende dos argumentos (ex.: `read` ou `send` conforme a ação). Tem de devolver uma classe válida. */
	effectForArgs?: (args: z.output<S>) => Effect;
	/** Fatos tipados para o cartão de aprovação, tirados dos argumentos. */
	riskFacts?: (args: z.output<S>) => RiskFacts;
	/**
	 * Completa os fatos com uma leitura (ex.: o evento que será apagado). Roda só quando o cartão de aprovação vai ser
	 * pedido, com o fato síncrono já pronto; se falhar, o cartão sai com o fato síncrono (melhor esforço, nunca bloqueia).
	 */
	enrichRiskFacts?: (args: z.output<S>, base: RiskFacts, ctx: { ownerId: string; signal?: AbortSignal }) => Promise<RiskFacts>;
	/** Ação da lista fixa de handoff (trocar senha, aceitar termos…), decidida pela tool a partir dos args tipados. */
	handoffKind?: (args: z.output<S>) => HandoffKind | undefined;
	/** O resultado vem de fora (e-mail, web, arquivo, MCP de terceiro, outro bot)? Então é dado, nunca instrução, e vira taint do run. Padrão: confiável. */
	trust?: "trusted" | "untrusted";
	/** Obrigatório com `trust: "untrusted"`. */
	source?: TrustSource;
	/** O resultado traz dado privado do dono (e-mail, arquivo, memória, conector privado). Padrão: não. */
	privateData?: boolean;
	/** Que tipo de dado do dono o resultado traz (e-mail, arquivo, memória, conector privado). Exige `privateData: true`: a guarda `guards/private-data.test.ts` e o `defineTool` cobram. */
	ownerData?: OwnerDataKind;
	/** A tool manda dado escolhido pelo modelo (URL, consulta) a um terceiro. Pede aprovação só com a trifeta completa no run (não confiável + privado; cláusula 8). Padrão: não. */
	egress?: boolean;
	/** Saída que depende dos argumentos (ex.: digitar texto numa página escreve dado do run num site de terceiro). Soma-se a `egress`. */
	egressForArgs?: (args: z.output<S>) => boolean;
	/** Confirmação declarada: `always` = o dono confirma toda chamada (mesmo em autonomia total); `when_untrusted` = só se o run leu dado não confiável. Sem dono, a tool fica fora. Padrão: nenhuma. */
	confirm?: "always" | "when_untrusted";
	/** A tool precisa de um dado que SÓ o dono digita no cartão de aprovação (hoje: o CVV do cartão). Com isso, nem o mandato dispensa o cartão: ele vira "só o campo". */
	ownerInput?: "card_cvv";
	/**
	 * Os argumentos aceitam `{{secret:NOME}}`: o executor troca pelo valor do cofre na hora de executar (depois da aprovação) e
	 * redige a saída. Só para tool que leva o dado ao serviço do próprio dono (conector, shell de código). Padrão: não, e o
	 * marcador segue literal.
	 */
	acceptsSecretRefs?: boolean;
	/** A chamada encerra o turno (ex.: pergunta ao dono). */
	endsTurn?: boolean;
	/** A chamada encerra o RUN sem outra chamada ao modelo e sem cartão (ex.: `agenda_result`, que fecha o run de agenda). */
	endsRun?: boolean;
	execute: (args: z.output<S>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};

/** Tool registrável. Só `defineTool` produz uma (conferido por `isDefinedTool`). */
export interface Tool {
	readonly name: string;
	readonly description: string;
	readonly effect: Effect;
	readonly endsTurn: boolean;
	/** Ver `ToolDefinition.endsRun`. */
	readonly endsRun: boolean;
	/** Ver `ToolDefinition.privateData`. */
	readonly privateData: boolean;
	/** Ver `ToolDefinition.ownerData`. */
	readonly ownerData?: OwnerDataKind;
	/** Ver `ToolDefinition.egress`. */
	readonly egress: boolean;
	/** `egress` desta chamada (a base, ou o de `egressForArgs`). Args inválidos usam a base. */
	egressFor(rawArgs: unknown): boolean;
	/** Ver `ToolDefinition.confirm`. */
	readonly confirm?: "always" | "when_untrusted";
	/** Ver `ToolDefinition.ownerInput`. */
	readonly ownerInput?: "card_cvv";
	/** Ver `ToolDefinition.acceptsSecretRefs`. */
	readonly acceptsSecretRefs: boolean;
	readonly trust: "trusted" | "untrusted";
	/** Origem do dado quando `trust` é `untrusted`. */
	readonly source?: TrustSource;
	/** JSON Schema dos argumentos, gerado do zod uma vez; estável byte a byte. */
	readonly jsonSchema: Readonly<Record<string, unknown>>;
	/** Campos aceitos, na ordem do schema. */
	readonly acceptedFields: readonly string[];
	/** Classe de efeito desta chamada (a base, ou a de `effectForArgs`). Args inválidos usam a base. */
	effectFor(rawArgs: unknown): Effect;
	riskFactsFor(rawArgs: unknown): RiskFacts | undefined;
	/** Fatos do cartão já completos pela leitura da tool (ver `ToolDefinition.enrichRiskFacts`). Nunca lança. */
	enrichedRiskFactsFor(rawArgs: unknown, ctx: { ownerId: string; signal?: AbortSignal }): Promise<RiskFacts | undefined>;
	handoffKindFor(rawArgs: unknown): HandoffKind | undefined;
	/** Valida os args, executa e devolve sempre um `ToolResult` honesto; nunca lança. */
	run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult>;
	toLlmToolSpec(): LlmToolSpec;
}

const defined = new WeakSet<object>();

export function isDefinedTool(value: unknown): value is Tool {
	return typeof value === "object" && value !== null && defined.has(value);
}

const NAME_FORMAT = /^[a-z][a-z0-9_]*$/;

function validateArgs<S extends z.ZodObject>(name: string, schema: S, fields: readonly string[], rawArgs: unknown): { ok: true; args: z.output<S> } | { ok: false; error: string; hint: string } {
	const hint = fields.length > 0 ? `Accepted fields: ${fields.join(", ")}.` : "This tool takes no arguments.";
	if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
		return { ok: false, error: `Invalid arguments for ${name}: expected an object.`, hint };
	}
	const unknown = Object.keys(rawArgs).filter((key) => !fields.includes(key));
	if (unknown.length > 0) {
		return { ok: false, error: `Unknown field(s) for ${name}: ${unknown.join(", ")}.`, hint };
	}
	const parsed = schema.safeParse(rawArgs);
	if (parsed.success) return { ok: true, args: parsed.data };
	const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
	return { ok: false, error: `Invalid arguments for ${name}: ${problems.join("; ")}.`, hint };
}

function isToolResult(value: unknown): value is ToolResult {
	if (typeof value !== "object" || value === null) return false;
	const r = value as { ok?: unknown; summary?: unknown; error?: unknown };
	if (r.ok === true) return typeof r.summary === "string" && r.summary.length > 0 && !("error" in r);
	return r.ok === false && typeof r.error === "string" && r.error.length > 0;
}

/** Teto da leitura que completa o cartão de aprovação: passou disso, o cartão sai com o fato síncrono (nunca trava o run). */
export const RISK_FACTS_ENRICH_TIMEOUT_MS = 3_000;

export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): Tool {
	if (!NAME_FORMAT.test(def.name)) throw new Error(`defineTool: invalid tool name "${def.name}" (use snake_case).`);
	if (!isEffect(def.effect)) {
		throw new Error(`defineTool(${def.name}): missing or unknown effect "${String(def.effect)}". Declare one of: ${EFFECT_CLASSES.join(", ")}.`);
	}
	if (def.description.trim().length === 0) throw new Error(`defineTool(${def.name}): empty description.`);

	if (def.trust === "untrusted" && !def.source) throw new Error(`defineTool(${def.name}): trust "untrusted" needs a source (email, web, file, mcp, other_bot).`);

	if (def.ownerData !== undefined) {
		if (!(OWNER_DATA_KINDS as readonly string[]).includes(def.ownerData)) throw new Error(`defineTool(${def.name}): unknown ownerData "${String(def.ownerData)}". Use one of: ${OWNER_DATA_KINDS.join(", ")}.`);
		if (def.privateData !== true) throw new Error(`defineTool(${def.name}): ownerData "${def.ownerData}" needs privateData: true (the result carries the owner's private data).`);
	}

	const schema = def.inputSchema;
	const acceptedFields = Object.freeze(Object.keys(schema.shape));
	const jsonSchema = Object.freeze(inputJsonSchema(schema));
	const baseEffect = def.effect;

	const tool: Tool = {
		name: def.name,
		description: def.description,
		effect: baseEffect,
		endsTurn: def.endsTurn === true,
		endsRun: def.endsRun === true,
		privateData: def.privateData === true,
		...(def.ownerData && { ownerData: def.ownerData }),
		egress: def.egress === true,
		...(def.confirm && { confirm: def.confirm }),
		...(def.ownerInput && { ownerInput: def.ownerInput }),
		acceptsSecretRefs: def.acceptsSecretRefs === true,
		trust: def.trust ?? "trusted",
		...(def.source && { source: def.source }),
		jsonSchema,
		acceptedFields,
		effectFor(rawArgs) {
			if (!def.effectForArgs) return baseEffect;
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			if (!checked.ok) return baseEffect;
			const effect = def.effectForArgs(checked.args);
			if (!isEffect(effect)) throw new Error(`${def.name}.effectForArgs returned an unknown effect "${String(effect)}".`);
			return effect;
		},
		egressFor(rawArgs) {
			if (def.egress === true) return true;
			if (!def.egressForArgs) return false;
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			return checked.ok ? def.egressForArgs(checked.args) === true : false;
		},
		riskFactsFor(rawArgs) {
			if (!def.riskFacts) return undefined;
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			return checked.ok ? def.riskFacts(checked.args) : undefined;
		},
		async enrichedRiskFactsFor(rawArgs, ctx) {
			const base = tool.riskFactsFor(rawArgs);
			if (!def.enrichRiskFacts || !base) return base;
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			if (!checked.ok) return base;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeout = new Promise<RiskFacts>((resolve) => {
					timer = setTimeout(() => resolve({}), RISK_FACTS_ENRICH_TIMEOUT_MS);
				});
				return { ...base, ...(await Promise.race([def.enrichRiskFacts(checked.args, base, ctx), timeout])) };
			} catch {
				return base;
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		handoffKindFor(rawArgs) {
			if (!def.handoffKind) return undefined;
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			return checked.ok ? def.handoffKind(checked.args) : undefined;
		},
		async run(rawArgs, ctx) {
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			if (!checked.ok) return { ok: false, error: checked.error, hint: checked.hint };
			try {
				const result = await def.execute(checked.args, ctx);
				if (isToolResult(result)) return result;
				return { ok: false, error: `${def.name} returned a malformed result (expected { ok: true, summary } or { ok: false, error }).` };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		toLlmToolSpec() {
			return toLlmToolSpec(tool);
		},
	};
	defined.add(tool);
	return Object.freeze(tool);
}
