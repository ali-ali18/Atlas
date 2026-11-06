import { z } from "zod";
import type { LlmToolSpec } from "../ports/llm.js";

/** `z.int()` põe limites de inteiro seguro no schema: ruído para o modelo. */
function withoutSafeIntBounds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutSafeIntBounds);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key, item]) => !((key === "minimum" || key === "maximum") && Math.abs(Number(item)) === Number.MAX_SAFE_INTEGER))
			.map(([key, item]) => [key, withoutSafeIntBounds(item)]),
	);
}

/** JSON Schema (lado "input", o que o modelo escreve) do schema zod, sem `$schema`. Determinístico. */
export function inputJsonSchema(schema: z.ZodObject): Record<string, unknown> {
	const { $schema: _schema, ...json } = withoutSafeIntBounds(z.toJSONSchema(schema, { io: "input" })) as Record<string, unknown>;
	return json;
}

/** A definição que vai ao modelo: nome, descrição e JSON Schema. */
export function toLlmToolSpec(tool: { name: string; description: string; jsonSchema: Record<string, unknown> }): LlmToolSpec {
	return { name: tool.name, description: tool.description, inputSchema: tool.jsonSchema };
}
