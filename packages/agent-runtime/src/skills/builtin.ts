import { BUILTIN_SKILL_SOURCES } from "./builtin/generated.js";
import { devSessionsEnabled } from "./dev-enabled.js";

/**
 * Skills de fábrica: Markdown em `skills/builtin/<slug>.md`, embutido no código
 * por `scripts/gen-builtin-skills.mjs` (o tsc não copia .md). Somente leitura,
 * iguais para todo bot. Frontmatter: name (pt-BR, exibição), description e when
 * (inglês, para o modelo), groups (grupos de contexto) e version.
 */
export type BuiltinSkill = {
	slug: string;
	name: string;
	description: string;
	when: string;
	groups: string[];
	version: number;
	body: string;
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unquote(raw: string): string {
	const value = raw.trim();
	const quote = value.charAt(0);
	if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
	return value;
}

/** Lê um arquivo de skill de fábrica; devolve `null` quando o frontmatter é inválido. */
export function parseBuiltinSkill(slug: string, source: string): BuiltinSkill | null {
	if (!SLUG.test(slug)) return null;
	const lines = source.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (close === -1) return null;
	const fields = new Map<string, string>();
	for (const line of lines.slice(1, close)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const name = unquote(fields.get("name") ?? "");
	const description = unquote(fields.get("description") ?? "");
	const when = unquote(fields.get("when") ?? "");
	const version = Number(fields.get("version") ?? "1");
	const groupsRaw = (fields.get("groups") ?? "").trim();
	const groups = groupsRaw.startsWith("[") && groupsRaw.endsWith("]")
		? groupsRaw
				.slice(1, -1)
				.split(",")
				.map((item) => unquote(item))
				.filter(Boolean)
		: [];
	if (!name || !description || !Number.isInteger(version) || version < 1) return null;
	const body = lines.slice(close + 1).join("\n").trim();
	if (!body) return null;
	return { slug, name, description, when, groups: [...new Set(groups)], version, body };
}

/** Todas as skills válidas, ordenadas por slug (determinístico). */
export function loadBuiltinSkills(sources: Readonly<Record<string, string>> = BUILTIN_SKILL_SOURCES): BuiltinSkill[] {
	const skills: BuiltinSkill[] = [];
	for (const slug of Object.keys(sources).sort()) {
		const parsed = parseBuiltinSkill(slug, sources[slug] ?? "");
		if (parsed) skills.push(parsed);
	}
	return skills;
}

let cache: BuiltinSkill[] | undefined;

export function builtinSkills(): readonly BuiltinSkill[] {
	cache ??= loadBuiltinSkills();
	return cache;
}

/** Skill que só faz sentido com sessões de código (grupos só `dev`). */
export function isDevOnlySkill(skill: BuiltinSkill): boolean {
	return skill.groups.length > 0 && skill.groups.every((group) => group === "dev");
}

/** Skills de fábrica que o modelo pode ver: sem as de código quando as sessões de código estão desligadas. */
export function visibleBuiltinSkills(devEnabled: boolean = devSessionsEnabled()): readonly BuiltinSkill[] {
	return devEnabled ? builtinSkills() : builtinSkills().filter((skill) => !isDevOnlySkill(skill));
}

function slugOf(text: string): string {
	return text
		.normalize("NFD")
		.split("")
		.filter((char) => char < "̀" || char > "ͯ")
		.join("")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.join("-");
}

/** Por slug ou pelo nome de exibição (tolera caixa e acento). */
export function findBuiltinSkill(query: string, skills: readonly BuiltinSkill[] = builtinSkills()): BuiltinSkill | undefined {
	const slug = slugOf(query);
	if (!slug) return undefined;
	return skills.find((skill) => skill.slug === slug) ?? skills.find((skill) => slugOf(skill.name) === slug);
}

/**
 * Linhas do índice (constantes, ordenadas): `- slug [built-in]: descrição (when: ...)`.
 * `overridden` são slugs que o dono já tem: a dele vence e a de fábrica some.
 */
export function builtinSkillIndexText(overridden: ReadonlySet<string> = new Set(), skills: readonly BuiltinSkill[] = visibleBuiltinSkills()): string {
	return skills
		.filter((skill) => !overridden.has(skill.slug))
		.map((skill) => `- ${skill.slug} [built-in]: ${skill.description}${skill.when ? ` (when: ${skill.when})` : ""}`)
		.join("\n");
}

/** Uma linha por skill de fábrica ligada aos grupos pedidos (sem repetir), gerada do frontmatter. */
export function builtinGroupPointers(groups: ReadonlySet<string>, skills: readonly BuiltinSkill[] = visibleBuiltinSkills()): string {
	return skills
		.filter((skill) => skill.groups.some((group) => groups.has(group)))
		.map((skill) => `For hard cases read the built-in skill \`${skill.slug}\` (skill_read).`)
		.join("\n");
}
