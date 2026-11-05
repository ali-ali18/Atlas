import type { HandoffKind } from "@workspace/shared";
import { z } from "zod";
import { EFFECT_CLASSES, type Effect, isEffect } from "../contract/effects.js";
import type { TrustSource } from "../contract/provenance.js";
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
	/** Ação da lista fixa de handoff (trocar senha, aceitar termos…), decidida pela tool a partir dos args tipados. */
	handoffKind?: (args: z.output<S>) => HandoffKind | undefined;
	/** O resultado vem de fora (e-mail, web, arquivo, MCP de terceiro, outro bot)? Então é dado, nunca instrução, e vira taint do run. Padrão: confiável. */
	trust?: "trusted" | "untrusted";
	/** Obrigatório com `trust: "untrusted"`. */
	source?: TrustSource;
	/** A chamada encerra o turno (ex.: pergunta ao dono). */
	endsTurn?: boolean;
	execute: (args: z.output<S>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};

/** Tool registrável. Só `defineTool` produz uma (conferido por `isDefinedTool`). */
export interface Tool {
	readonly name: string;
	readonly description: string;
	readonly effect: Effect;
	readonly endsTurn: boolean;
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

export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): Tool {
	if (!NAME_FORMAT.test(def.name)) throw new Error(`defineTool: invalid tool name "${def.name}" (use snake_case).`);
	if (!isEffect(def.effect)) {
		throw new Error(`defineTool(${def.name}): missing or unknown effect "${String(def.effect)}". Declare one of: ${EFFECT_CLASSES.join(", ")}.`);
	}
	if (def.description.trim().length === 0) throw new Error(`defineTool(${def.name}): empty description.`);

	if (def.trust === "untrusted" && !def.source) throw new Error(`defineTool(${def.name}): trust "untrusted" needs a source (email, web, file, mcp, other_bot).`);

	const schema = def.inputSchema;
	const acceptedFields = Object.freeze(Object.keys(schema.shape));
	const jsonSchema = Object.freeze(inputJsonSchema(schema));
	const baseEffect = def.effect;

	const tool: Tool = {
		name: def.name,
		description: def.description,
		effect: baseEffect,
		endsTurn: def.endsTurn === true,
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
		riskFactsFor(rawArgs) {
			if (!def.riskFacts) return undefined;
			const checked = validateArgs(def.name, schema, acceptedFields, rawArgs);
			return checked.ok ? def.riskFacts(checked.args) : undefined;
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
