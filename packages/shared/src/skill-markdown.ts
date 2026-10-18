/**
 * Skill como documento Markdown (PLANO-SKILLS K0). Função pura: sem I/O, sem
 * `process.env`. Formato:
 *
 * ---
 * name: weekly-report
 * description: Quando usar esta skill (até 300 caracteres, uma linha)
 * tools: [github, calendar]
 * ---
 * corpo markdown livre (até ~16 KB, blocos de código permitidos)
 *
 * `tools` é só dica: o runtime nunca trata como permissão.
 */

export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 300;
export const SKILL_BODY_MAX_BYTES = 16 * 1024;
export const SKILL_TOOLS_MAX_ITEMS = 20;
export const SKILL_TOOL_MAX_CHARS = 64;
export const SKILL_MAX_PER_SCOPE = 64;
export const SKILL_MAX_PER_USER = 200;
export const SKILL_REVISIONS_KEPT = 10;
export const SKILL_INDEX_MAX_ITEMS = 64;
export const SKILL_INDEX_MAX_CHARS = 6000;
/** Folga para o frontmatter ao validar o tamanho do documento inteiro. */
export const SKILL_DOCUMENT_MAX_BYTES = SKILL_BODY_MAX_BYTES + 4 * 1024;

export const SKILL_STATUSES = ["active", "draft"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];
export const SKILL_CREATORS = ["user", "agent"] as const;
export type SkillCreator = (typeof SKILL_CREATORS)[number];

/** Linha fixa (modelo): o índice estourou o teto e há mais skills. */
export const SKILL_INDEX_OVERFLOW_LINE =
	"(More skills exist than are listed here; call skill_read with the exact skill name if you know it.)";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const KNOWN_KEYS = ["name", "description", "tools"] as const;

export type SkillMarkdown = {
	name: string;
	description: string;
	tools: string[];
	body: string;
};

export type SkillParseResult =
	| { ok: true; skill: SkillMarkdown }
	| { ok: false; errors: string[] };

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Converte texto livre em slug `[a-z0-9-]` (1-64); vazio quando não sobra nada. */
export function slugifySkillName(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SKILL_NAME_MAX_CHARS)
		.replace(/-+$/g, "");
}

/** Valida os campos já separados (usado pelo parse e pelas rotas JSON). */
export function validateSkillFields(input: {
	name: unknown;
	description: unknown;
	body: unknown;
	tools?: unknown;
}): SkillParseResult {
	const errors: string[] = [];

	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!name) errors.push("O nome é obrigatório.");
	else if (name.length > SKILL_NAME_MAX_CHARS || !NAME_PATTERN.test(name)) {
		errors.push(
			`O nome deve ser um slug (letras minúsculas, números e hífens) com até ${SKILL_NAME_MAX_CHARS} caracteres.`,
		);
	}

	const description = typeof input.description === "string" ? input.description.trim() : "";
	if (!description) errors.push("A descrição é obrigatória.");
	else if (/[\r\n]/.test(description)) errors.push("A descrição deve ter uma única linha.");
	else if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
		errors.push(`A descrição deve ter até ${SKILL_DESCRIPTION_MAX_CHARS} caracteres.`);
	}

	const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
	if (!body) errors.push("O corpo da skill não pode ficar vazio.");
	else if (byteLength(body) > SKILL_BODY_MAX_BYTES) {
		errors.push(`O corpo deve ter até ${SKILL_BODY_MAX_BYTES / 1024} KB.`);
	}

	const tools: string[] = [];
	if (input.tools !== undefined && input.tools !== null) {
		if (!Array.isArray(input.tools)) errors.push("tools deve ser uma lista.");
		else if (input.tools.length > SKILL_TOOLS_MAX_ITEMS) {
			errors.push(`tools aceita até ${SKILL_TOOLS_MAX_ITEMS} itens.`);
		} else {
			for (const item of input.tools) {
				const tool = typeof item === "string" ? item.trim() : "";
				if (!tool || tool.length > SKILL_TOOL_MAX_CHARS || !TOOL_PATTERN.test(tool)) {
					errors.push(`Item inválido em tools: ${JSON.stringify(item).slice(0, 40)}.`);
				} else if (!tools.includes(tool)) tools.push(tool);
			}
		}
	}

	return errors.length ? { ok: false, errors } : { ok: true, skill: { name, description, tools, body } };
}

function parseScalar(raw: string): string | null {
	const value = raw.trim();
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : null;
		} catch {
			return null;
		}
	}
	if (value.startsWith("'")) {
		return value.length >= 2 && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : null;
	}
	return value;
}

function parseInlineList(raw: string): string[] | null {
	const value = raw.trim();
	if (!value.startsWith("[") || !value.endsWith("]")) return null;
	const inner = value.slice(1, -1).trim();
	if (!inner) return [];
	const items: string[] = [];
	for (const part of inner.split(",")) {
		const item = parseScalar(part);
		if (item === null) return null;
		items.push(item);
	}
	return items;
}

/** Lê o documento `.md` com frontmatter. Validação estrita, erros em pt-BR. */
export function parseSkillMarkdown(text: unknown): SkillParseResult {
	if (typeof text !== "string" || !text.trim()) {
		return { ok: false, errors: ["O documento da skill está vazio."] };
	}
	if (byteLength(text) > SKILL_DOCUMENT_MAX_BYTES) {
		return { ok: false, errors: [`O documento deve ter até ${SKILL_DOCUMENT_MAX_BYTES / 1024} KB.`] };
	}
	const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
	if (lines[0]?.trim() !== "---") {
		return { ok: false, errors: ["O documento precisa começar com o frontmatter (linha `---`)."] };
	}
	const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (close === -1) {
		return { ok: false, errors: ["O frontmatter não foi fechado (falta a segunda linha `---`)."] };
	}

	const errors: string[] = [];
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		if (!line.trim()) continue;
		const match = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
		if (!match) {
			errors.push(`Linha inválida no frontmatter: ${JSON.stringify(line.slice(0, 40))}.`);
			continue;
		}
		const key = match[1] as string;
		if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
			errors.push(`Chave desconhecida no frontmatter: ${key}. Use name, description ou tools.`);
		} else if (key in fields) {
			errors.push(`Chave repetida no frontmatter: ${key}.`);
		} else {
			fields[key] = match[2] as string;
		}
	}

	let description: string | null | undefined;
	if (fields.description !== undefined) {
		description = parseScalar(fields.description);
		if (description === null) errors.push("A descrição está com aspas malformadas.");
	}
	let name: string | null | undefined;
	if (fields.name !== undefined) {
		name = parseScalar(fields.name);
		if (name === null) errors.push("O nome está com aspas malformadas.");
	}
	let tools: string[] | null | undefined;
	if (fields.tools !== undefined) {
		tools = parseInlineList(fields.tools);
		if (tools === null) errors.push("tools deve ser uma lista no formato [a, b].");
	}
	if (errors.length) return { ok: false, errors };

	return validateSkillFields({
		name: name ?? "",
		description: description ?? "",
		tools: tools ?? undefined,
		body: lines.slice(close + 1).join("\n"),
	});
}

function renderScalar(value: string): string {
	// Sem aspas só texto simples; qualquer símbolo de YAML (":", "#", aspas) vai entre aspas JSON.
	return /^[A-Za-z0-9][^:#"'\\\n]*$/.test(value) ? value : JSON.stringify(value);
}

/** Caminho inverso do parse (export e card). `parse(render(x))` devolve `x`. */
export function renderSkillMarkdown(skill: SkillMarkdown): string {
	const head = ["---", `name: ${skill.name}`, `description: ${renderScalar(skill.description)}`];
	if (skill.tools.length) head.push(`tools: [${skill.tools.join(", ")}]`);
	head.push("---");
	return `${head.join("\n")}\n\n${skill.body.trim()}\n`;
}

export type SkillIndexEntry = {
	name: string;
	description: string;
	enabled?: boolean;
	status?: SkillStatus;
};

/**
 * Colisão de nome entre escopos: a skill do bot vence a da conta (decisão do
 * plano). Pura; o chamador passa as duas listas já filtradas pelo dono.
 */
export function mergeSkillScopes<T extends { name: string }>(account: readonly T[], bot: readonly T[]): T[] {
	const byName = new Map<string, T>();
	for (const skill of account) byName.set(skill.name, skill);
	for (const skill of bot) byName.set(skill.name, skill);
	return [...byName.values()];
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Índice para o prompt: `- <name>: <description>`, ordenado por nome, só
 * `enabled` + `active`. Determinístico (mesma entrada, mesmos bytes) para não
 * invalidar o cache de prompt. Estourando o teto, termina com linha fixa.
 */
export function buildSkillIndex(
	skills: readonly SkillIndexEntry[],
	opts: { maxItems?: number; maxChars?: number } = {},
): string {
	const maxItems = opts.maxItems ?? SKILL_INDEX_MAX_ITEMS;
	const maxChars = opts.maxChars ?? SKILL_INDEX_MAX_CHARS;
	const usable = skills
		.filter((skill) => skill.enabled !== false && (skill.status ?? "active") === "active")
		.sort((a, b) => compareNames(a.name, b.name));
	if (!usable.length) return "";

	const lines: string[] = [];
	let used = 0;
	let truncated = false;
	for (const skill of usable) {
		const line = `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`;
		const next = used + line.length + 1;
		if (lines.length >= maxItems || next > maxChars - SKILL_INDEX_OVERFLOW_LINE.length - 1) {
			truncated = true;
			break;
		}
		lines.push(line);
		used = next;
	}
	if (truncated) lines.push(SKILL_INDEX_OVERFLOW_LINE);
	return lines.join("\n");
}
