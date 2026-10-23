/**
 * Disciplina de execução por família de modelo (como o `TOOL_USE_ENFORCEMENT`/`EXECUTION_GUIDANCE` do Hermes,
 * escolhido por substring do id do modelo). Modelo menos agêntico (DeepSeek, Qwen, GLM, Kimi, GPT/o-series e os
 * que não conhecemos) recebe o bloco completo; Gemini um intermediário; Claude só o mínimo, que vale para todos
 * e substitui as frases de "não prometa, só afirme o que a tool mostrou" que ficavam no núcleo.
 *
 * Pura e estável: o mesmo id dá sempre os mesmos bytes, então o bloco fica no prefixo estável (cache).
 */

export type DisciplineLevel = "minimal" | "standard" | "full";

/** Ordem importa: a primeira família cujo padrão casa com o id decide. */
export const MODEL_DISCIPLINE_FAMILIES: ReadonlyArray<{ family: string; pattern: RegExp; level: DisciplineLevel }> = [
	{ family: "claude", pattern: /claude|anthropic/, level: "minimal" },
	{ family: "gemini", pattern: /gemini/, level: "standard" },
	{ family: "deepseek", pattern: /deepseek/, level: "full" },
	{ family: "qwen", pattern: /qwen|qwq/, level: "full" },
	{ family: "glm", pattern: /glm|zhipu|z-ai/, level: "full" },
	{ family: "kimi", pattern: /kimi|moonshot/, level: "full" },
	{ family: "gpt", pattern: /gpt|openai\/o\d|(^|\/)o\d(-|$)/, level: "full" },
];

/** Sem família conhecida: provavelmente um modelo aberto/barato, então o bloco completo. */
const UNKNOWN_LEVEL: DisciplineLevel = "full";

const MINIMAL_LINES = [
	"- Finish in this turn: if something needs checking, call the tool now; never end with a promise to check or do it later (\"let me check…\").",
	"- Claim only what a tool result in this task shows. Never say you opened, saw, sent or saved something the latest result or screenshot does not show; if a tool failed or returned an unexpected page, say so with the real error. Never say you cannot do something before trying the matching tool.",
];

const ACT_LINE =
	"- Act through tools: when a step needs data or an action, call the tool instead of describing what you would do. Independent read-only calls can go in one step.";

const FULL_EXTRA_LINES = [
	"- Numbers come from tools: do arithmetic, totals, counts and date math with a tool (run_code) or straight from tool results; never estimate them.",
	"- Tool-call arguments must be valid JSON that matches the schema; on an argument error, fix the field it names and retry once.",
	"- Ask at most one question, and only when you are blocked.",
];

export function disciplineLevelForModel(modelId: string | undefined): DisciplineLevel {
	const id = (modelId ?? "").trim().toLowerCase();
	if (!id) return UNKNOWN_LEVEL;
	return MODEL_DISCIPLINE_FAMILIES.find((entry) => entry.pattern.test(id))?.level ?? UNKNOWN_LEVEL;
}

/** Bloco de disciplina para o prompt estável (inglês, curto). */
export function disciplineForModel(modelId: string | undefined): string {
	const level = disciplineLevelForModel(modelId);
	const lines = level === "minimal" ? MINIMAL_LINES : level === "standard" ? [ACT_LINE, ...MINIMAL_LINES] : [ACT_LINE, ...MINIMAL_LINES, ...FULL_EXTRA_LINES];
	return ["Execution discipline:", ...lines].join("\n");
}
