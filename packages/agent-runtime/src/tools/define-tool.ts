import { z } from "zod";
import type { ChatTool } from "@workspace/llm";
import type { ToolContext, ToolEffect, ToolGroup, ToolHandler, ToolMetaFields, ToolRegistration, ToolResult } from "./registry/types.js";

/**
 * `defineTool` (harness v3, PR5; pedido do dono 03/11): um lugar só por tool, no estilo `tool()` do AI SDK/EVE.
 * Do mesmo objeto saem a definição enviada ao modelo (schema gerado do zod), o metadado do PR1 (`effect`, `poll`,
 * `endsTurn`, `needsHuman`, `ownCard`...) e o handler do registro, com os args já validados pelo schema.
 *
 * Tools antigas migram aos poucos: a tabela `TOOL_META` continua como fallback e o teste `define-tool.test.ts` falha
 * se um nome novo entrar na tabela em vez de passar por aqui.
 */
export type DefinedTool = {
	readonly name: string;
	/** Ausente só nas tools legadas sem schema próprio (alias de nome antigo que o modelo não vê). */
	readonly definition?: ChatTool;
	readonly meta: ToolMetaFields;
	readonly group: ToolGroup;
	/** Valida os args pelo schema e roda; arg inválido = erro honesto com a assinatura curta. */
	readonly handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

type Input = z.ZodObject<z.ZodRawShape>;

export type DefineToolSpec<S extends Input> = {
	name: string;
	description: string;
	input: S;
	effect: ToolEffect;
	effectForArgs?: (args: z.output<S>) => ToolEffect;
	catalogEffect?: ToolEffect;
	poll?: boolean;
	endsTurn?: boolean;
	needsHuman?: true;
	/** A tool tem cartão de aprovação próprio: o motor v3 não mostra o cartão genérico em cima dele. */
	ownCard?: true;
	group: ToolGroup;
	run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};

/** `z.int()` põe os limites de inteiro seguro no schema: ruído para o modelo, que só custa caracteres. */
function withoutSafeIntBounds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutSafeIntBounds);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key, item]) => !((key === "minimum" || key === "maximum") && Math.abs(Number(item)) === Number.MAX_SAFE_INTEGER))
			.map(([key, item]) => [key, withoutSafeIntBounds(item)]),
	);
}

/** Schema JSON do zod no formato do `ChatTool` (sem `$schema`; o lado "input", que é o que o modelo escreve). */
export function toolParameters(input: Input): ChatTool["function"]["parameters"] {
	const { $schema: _schema, ...json } = withoutSafeIntBounds(z.toJSONSchema(input, { io: "input" })) as Record<string, unknown>;
	const properties = (json.properties ?? {}) as Record<string, unknown>;
	const required = Array.isArray(json.required) ? (json.required as string[]) : [];
	const { properties: _p, required: _r, type: _t, ...rest } = json;
	return { type: "object", properties, ...(required.length > 0 ? { required } : {}), ...rest };
}

/** Assinatura curta (`name(a: string, b?: number)`) para o erro de argumento. */
function signatureOf(definition: ChatTool): string {
	const required = new Set(definition.function.parameters.required ?? []);
	const params = Object.entries(definition.function.parameters.properties).map(([key, schema]) => {
		const type = schema && typeof schema === "object" && "type" in schema && typeof schema.type === "string" ? schema.type : "unknown";
		return `${key}${required.has(key) ? "" : "?"}: ${type === "integer" ? "number" : type}`;
	});
	return `${definition.function.name}(${params.join(", ")})`;
}

/** `null` num campo opcional = omitido (modelos mandam `null` para "sem valor"); o schema decide o resto. */
function withoutNulls(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
}

export function defineTool<S extends Input>(spec: DefineToolSpec<S>): DefinedTool & { readonly definition: ChatTool } {
	const definition: ChatTool = { type: "function", function: { name: spec.name, description: spec.description, parameters: toolParameters(spec.input) } };
	const meta: ToolMetaFields = {
		effect: spec.effect,
		...(spec.poll ? { poll: true } : {}),
		...(spec.endsTurn ? { endsTurn: true } : {}),
		...(spec.needsHuman ? { needsHuman: true as const } : {}),
		...(spec.ownCard ? { ownCard: true as const } : {}),
		...(spec.catalogEffect ? { catalogEffect: spec.catalogEffect } : {}),
		...(spec.effectForArgs
			? {
					effectForArgs: (args: Record<string, unknown>) => {
						const parsed = spec.input.safeParse(withoutNulls(args));
						// Args que não passam no schema nunca executam: vale o pior caso.
						return parsed.success ? spec.effectForArgs!(parsed.data) : spec.effect;
					},
				}
			: {}),
	};
	const handler = async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
		const parsed = spec.input.safeParse(withoutNulls(args));
		if (!parsed.success) {
			const reason = parsed.error.issues
				.slice(0, 3)
				.map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
				.join("; ");
			throw new Error(`Invalid arguments: ${reason}. Expected: ${signatureOf(definition)}.`);
		}
		return await spec.run(parsed.data, ctx);
	};
	return { name: spec.name, definition, meta, group: spec.group, handler };
}

/**
 * Mesma ideia do `defineTool`, para a tool que já tem o schema JSON escrito à mão e o handler que confere os
 * próprios args (PR5b: migração sem mudar um byte do que o modelo vê nem o jeito de validar). `definition` entra
 * como está (a mesma referência); sem ela, é uma tool legada sem schema (o modelo não a enxerga).
 * Tool nova usa `defineTool` com zod; este é o caminho das nativas antigas.
 */
export type DefineRawToolSpec = {
	name: string;
	definition?: ChatTool;
	effect: ToolEffect;
	effectForArgs?: (args: Record<string, unknown>) => ToolEffect;
	catalogEffect?: ToolEffect;
	poll?: boolean;
	endsTurn?: boolean;
	needsHuman?: true;
	ownCard?: true;
	group: ToolGroup;
	run: ToolHandler;
};

export function defineRawTool(spec: DefineRawToolSpec): DefinedTool {
	if (spec.definition && spec.definition.function.name !== spec.name) throw new Error(`defineRawTool: a definição é de "${spec.definition.function.name}", não de "${spec.name}".`);
	const meta: ToolMetaFields = {
		effect: spec.effect,
		...(spec.poll ? { poll: true } : {}),
		...(spec.endsTurn ? { endsTurn: true } : {}),
		...(spec.needsHuman ? { needsHuman: true as const } : {}),
		...(spec.ownCard ? { ownCard: true as const } : {}),
		...(spec.catalogEffect ? { catalogEffect: spec.catalogEffect } : {}),
		...(spec.effectForArgs ? { effectForArgs: spec.effectForArgs } : {}),
	};
	return { name: spec.name, ...(spec.definition ? { definition: spec.definition } : {}), meta, group: spec.group, handler: async (args, ctx) => await spec.run(args, ctx) };
}

/** Registros do registro de tools (`ToolFamily`) a partir das tools definidas aqui. */
export function definedFamily(tools: readonly DefinedTool[]): Record<string, ToolRegistration> {
	return Object.fromEntries(tools.map((tool) => [tool.name, { ...tool.meta, group: tool.group, handler: tool.handler, defined: true as const, ...(tool.definition ? { definition: tool.definition } : {}) }]));
}
