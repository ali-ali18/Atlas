/**
 * Regras das lições (fase 2: lembrar não é cumprir). Uma lição "checável por máquina" pode carregar uma regra que o
 * runtime aplica ANTES de cada ferramenta, em código determinístico (sem LLM). Regras só APERTAM o comportamento:
 *   - `required_args`: a chamada precisa trazer os campos listados;
 *   - `require_prior_call`: antes de X, Y precisa ter rodado com sucesso neste run;
 *   - `confirm_always`: X sempre passa pelo cartão de confirmação, mesmo que a autonomia deixasse.
 * O formato é estrito: tipo desconhecido ou campo extra (liberar aprovação, trocar destinatário/destino, pular
 * checagem) é recusado, nunca "consertado". Funções puras (sem I/O).
 */
import { redactSecrets } from "./redact-secrets.js";

export const LESSON_RULE_KINDS = ["required_args", "require_prior_call", "confirm_always"] as const;
export type LessonRuleKind = (typeof LESSON_RULE_KINDS)[number];

export type RequiredArgsRule = { kind: "required_args"; tool: string; fields: string[]; note?: string };
export type RequirePriorCallRule = { kind: "require_prior_call"; tool: string; requires: string; within: "run" };
export type ConfirmAlwaysRule = { kind: "confirm_always"; tool: string };
export type LessonRule = RequiredArgsRule | RequirePriorCallRule | ConfirmAlwaysRule;

export const LESSON_RULE_MAX_FIELDS = 8;
export const LESSON_RULE_NOTE_MAX_CHARS = 160;
const TOOL_PATTERN = /^[A-Za-z0-9_.:*-]{3,120}$/;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,39}(\.[A-Za-z0-9_]{1,40}){0,5}$/;
/** E-mail, URL ou telefone: dado concreto que uma nota de regra vinda do refletor não pode trazer. */
const DATA_IN_NOTE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\bhttps?:\/\/\S+|\bwww\.\S+|\+?\d[\d\s().-]{7,}\d/iu;

const ALLOWED_KEYS: Record<LessonRuleKind, readonly string[]> = {
	required_args: ["kind", "tool", "fields", "note"],
	require_prior_call: ["kind", "tool", "requires", "within"],
	confirm_always: ["kind", "tool"],
};

export type ParsedLessonRule = { ok: true; rule: LessonRule } | { ok: false; reason: string };

export function isLessonRuleKind(value: unknown): value is LessonRuleKind {
	return typeof value === "string" && (LESSON_RULE_KINDS as readonly string[]).includes(value);
}

function toolPatternProblem(value: unknown, label: string): string | null {
	if (typeof value !== "string" || !TOOL_PATTERN.test(value.trim())) return `${label} inválido (use o nome da tool, com * opcional)`;
	if (value.replace(/\*/g, "").length < 3) return `${label} amplo demais`;
	return null;
}

/**
 * Valida e normaliza uma regra. `userAuthored` (editada pelo dono na aba Lições) aceita qualquer texto na nota;
 * a vinda do refletor não pode trazer e-mail, URL ou telefone.
 */
export function parseLessonRule(raw: unknown, opts: { userAuthored?: boolean } = {}): ParsedLessonRule {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "regra inválida" };
	const row = raw as Record<string, unknown>;
	if (!isLessonRuleKind(row.kind)) return { ok: false, reason: "tipo de regra desconhecido: regras só restringem (campos obrigatórios, chamada prévia, confirmar sempre)" };
	const extra = Object.keys(row).find((key) => !ALLOWED_KEYS[row.kind as LessonRuleKind].includes(key));
	if (extra) return { ok: false, reason: `campo não permitido na regra: ${extra.slice(0, 40)}` };
	const toolProblem = toolPatternProblem(row.tool, "tool");
	if (toolProblem) return { ok: false, reason: toolProblem };
	const tool = (row.tool as string).trim();
	if (row.kind === "confirm_always") return { ok: true, rule: { kind: "confirm_always", tool } };
	if (row.kind === "require_prior_call") {
		const requiresProblem = toolPatternProblem(row.requires, "requires");
		if (requiresProblem) return { ok: false, reason: requiresProblem };
		const requires = (row.requires as string).trim();
		if (row.within !== "run") return { ok: false, reason: 'within precisa ser "run"' };
		if (requires === tool) return { ok: false, reason: "a chamada prévia não pode ser a própria tool" };
		return { ok: true, rule: { kind: "require_prior_call", tool, requires, within: "run" } };
	}
	if (!Array.isArray(row.fields) || row.fields.length === 0 || row.fields.length > LESSON_RULE_MAX_FIELDS) return { ok: false, reason: `fields precisa ter de 1 a ${LESSON_RULE_MAX_FIELDS} campos` };
	const fields: string[] = [];
	for (const field of row.fields) {
		if (typeof field !== "string" || !FIELD_PATH.test(field.trim())) return { ok: false, reason: "caminho de campo inválido" };
		if (!fields.includes(field.trim())) fields.push(field.trim());
	}
	let note: string | undefined;
	if (row.note !== undefined) {
		if (typeof row.note !== "string") return { ok: false, reason: "nota inválida" };
		note = redactSecrets(row.note.replace(/\s+/g, " ").trim()).slice(0, LESSON_RULE_NOTE_MAX_CHARS);
		if (note && !opts.userAuthored && DATA_IN_NOTE.test(note)) return { ok: false, reason: "a nota da regra não pode trazer e-mail, URL ou telefone" };
	}
	return { ok: true, rule: { kind: "required_args", tool, fields, ...(note ? { note } : {}) } };
}

/** Leitura tolerante do que está gravado (coluna JSON): regra inválida = sem regra. */
export function readLessonRule(raw: unknown): LessonRule | null {
	if (raw === null || raw === undefined) return null;
	const parsed = parseLessonRule(raw, { userAuthored: true });
	return parsed.ok ? parsed.rule : null;
}

/** `tool` casa com o nome exposto ou o nome original; `*` vale por qualquer trecho. */
export function toolPatternMatches(pattern: string, ...names: Array<string | undefined>): boolean {
	const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	return names.some((name) => typeof name === "string" && name.length > 0 && regex.test(name));
}

/** Resumo curto em português (aba Lições, inspetor). */
export function describeLessonRule(rule: LessonRule): string {
	if (rule.kind === "required_args") return `Exige ${rule.fields.join(", ")} em ${rule.tool}`;
	if (rule.kind === "require_prior_call") return `Exige ${rule.requires} antes de ${rule.tool}`;
	return `Sempre confirma ${rule.tool}`;
}

/** Valor de um caminho `a.b.0` nos argumentos; `undefined` se não existe. */
export function readArgPath(args: unknown, path: string): unknown {
	let current: unknown = args;
	for (const part of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Preenchido: não nulo, texto não vazio, lista/objeto não vazios (0 e false contam como preenchidos). */
export function isArgPresent(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value as object).length > 0;
	return true;
}
