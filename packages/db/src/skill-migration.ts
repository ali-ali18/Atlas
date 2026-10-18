/**
 * Migração das receitas antigas (`Skill`/`SkillVersion`) para `SkillDoc`
 * (PLANO-SKILLS K0.4). Idempotente: o id novo é `migrated-<id da skill
 * antiga>`, então rodar de novo não duplica. Preserva o dono (`userId`); linhas
 * sem dono real (legado "default") não são atribuídas a ninguém. Descarta
 * usage, evidence, evaluation, learning job/budget e pending intents.
 * O relatório traz só contagens e nomes, nunca o conteúdo.
 */
import {
	SKILL_DESCRIPTION_MAX_CHARS,
	SKILL_NAME_MAX_CHARS,
	SKILL_TOOLS_MAX_ITEMS,
	redactSecrets,
	slugifySkillName,
	validateSkillFields,
} from "@workspace/shared";
import { prisma as defaultPrisma } from "./client.js";

type Db = typeof defaultPrisma;

export type MigratedSkillFields = { description: string; tools: string[]; body: string };

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).map(text).filter(Boolean);

function section(title: string, lines: string[]): string[] {
	return lines.length ? [`## ${title}`, ...lines, ""] : [];
}

/** Receita (JSON) -> campos da skill em Markdown. `null` se não parece receita. */
export function recipeToSkillFields(content: unknown): (MigratedSkillFields & { title: string; capabilityKey: string }) | null {
	if (!content || typeof content !== "object" || Array.isArray(content)) return null;
	const recipe = content as Record<string, unknown>;
	const title = text(recipe.title);
	const goal = text(recipe.description);
	const steps = list(recipe.steps).flatMap((raw) => {
		const step = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const instruction = text(step.instruction);
		return instruction ? [{ instruction, tool: text(step.tool) }] : [];
	});
	if ((!title && !goal) || steps.length === 0) return null;

	const inputs = list(recipe.inputs).flatMap((raw) => {
		const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const name = text(input.name);
		if (!name) return [];
		return [`- \`${name}\`${input.required === true ? " (required)" : ""}: ${text(input.description)}`.trimEnd()];
	});
	const body = [
		...(title ? [`# ${title}`, ""] : []),
		...(goal ? [goal, ""] : []),
		...section("When to use", strings(recipe.triggers).map((t) => `- ${t}`)),
		...section("Before you start", strings(recipe.preconditions).map((t) => `- ${t}`)),
		...section("Inputs", inputs),
		...section("Steps", steps.map((s, i) => `${i + 1}. ${s.instruction}${s.tool ? ` (tool: \`${s.tool}\`)` : ""}`)),
		...section("Expected result", strings(recipe.postconditions).map((t) => `- ${t}`)),
		...section("If something goes wrong", strings(recipe.failureModes).map((t) => `- ${t}`)),
	]
		.join("\n")
		.trim();

	const summary = goal || title;
	const description =
		summary.length > SKILL_DESCRIPTION_MAX_CHARS ? `${summary.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 3).trimEnd()}...` : summary;
	const tools = [...new Set(strings(recipe.requiredTools))].slice(0, SKILL_TOOLS_MAX_ITEMS);
	return { title, capabilityKey: text(recipe.capabilityKey), description, tools, body };
}

/** Nome livre no escopo: sufixo -2, -3... sem passar de 64 caracteres. */
export function uniqueSkillName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, SKILL_NAME_MAX_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export type SkillMigrationOutcome =
	| "created"
	| "created_draft"
	| "already_migrated"
	| "skipped_no_version"
	| "skipped_invalid"
	| "skipped_unowned"
	| "failed";

export type SkillMigrationReport = {
	dryRun: boolean;
	total: number;
	counts: Record<SkillMigrationOutcome, number>;
	/** Só nome final e resultado; nunca descrição, corpo ou dono. */
	items: Array<{ name: string; outcome: SkillMigrationOutcome }>;
};

type LegacySkill = { id: string; userId: string; botId: string; capabilityKey: string; enabled: boolean; activeVersionId: string | null };
type LegacyVersion = { id: string; skillId: string; number: number; content: unknown; status: string; revokedAt: Date | null };

function pickVersion(skill: LegacySkill, versions: LegacyVersion[]): { version: LegacyVersion; draft: boolean } | null {
	const usable = versions.filter((v) => !v.revokedAt && v.status !== "rejected");
	const active = usable.find((v) => v.id === skill.activeVersionId && v.status === "active");
	if (active) return { version: active, draft: false };
	const latest = [...usable].filter((v) => v.status === "draft").sort((a, b) => b.number - a.number)[0];
	return latest ? { version: latest, draft: true } : null;
}

export async function migrateSkillsToMarkdown(opts: { dryRun: boolean; db?: Db }): Promise<SkillMigrationReport> {
	const db = opts.db ?? defaultPrisma;
	const counts: Record<SkillMigrationOutcome, number> = {
		created: 0,
		created_draft: 0,
		already_migrated: 0,
		skipped_no_version: 0,
		skipped_invalid: 0,
		skipped_unowned: 0,
		failed: 0,
	};
	const items: SkillMigrationReport["items"] = [];
	const record = (name: string, outcome: SkillMigrationOutcome) => {
		counts[outcome]++;
		items.push({ name, outcome });
	};

	const skills = (await db.skill.findMany({})) as LegacySkill[];
	const versions = (await db.skillVersion.findMany({ where: { skillId: { in: skills.map((s) => s.id) } } })) as LegacyVersion[];
	const owners = new Set((await db.user.findMany({ where: { id: { in: [...new Set(skills.map((s) => s.userId))] } }, select: { id: true } })).map((u) => u.id));
	const existing = await db.skillDoc.findMany({ where: { userId: { in: [...owners] } } });
	const existingIds = new Set(existing.map((d) => d.id));
	const taken = new Map<string, Set<string>>();
	const scopeKey = (userId: string, botId: string | null) => `${userId}|${botId ?? ""}`;
	for (const doc of existing) {
		const key = scopeKey(doc.userId, doc.botId);
		taken.set(key, (taken.get(key) ?? new Set()).add(doc.name));
	}

	for (const skill of [...skills].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const label = skill.capabilityKey || skill.id;
		const id = `migrated-${skill.id}`;
		if (!owners.has(skill.userId) || skill.userId === "default") {
			record(label, "skipped_unowned");
			continue;
		}
		if (existingIds.has(id)) {
			record(label, "already_migrated");
			continue;
		}
		const picked = pickVersion(skill, versions.filter((v) => v.skillId === skill.id));
		if (!picked) {
			record(label, "skipped_no_version");
			continue;
		}
		const fields = recipeToSkillFields(picked.version.content);
		const baseName = fields && (slugifySkillName(skill.capabilityKey) || slugifySkillName(fields.title) || "skill");
		if (!fields || !baseName) {
			record(label, "skipped_invalid");
			continue;
		}
		const botId = skill.botId.trim() && skill.botId !== "default" ? skill.botId : null;
		const names = taken.get(scopeKey(skill.userId, botId)) ?? new Set<string>();
		const name = uniqueSkillName(baseName, names);
		const valid = validateSkillFields({ name, description: fields.description, body: fields.body, tools: fields.tools });
		if (!valid.ok) {
			record(label, "skipped_invalid");
			continue;
		}
		names.add(name);
		taken.set(scopeKey(skill.userId, botId), names);

		const draft = picked.draft;
		if (!opts.dryRun) {
			try {
				await db.skillDoc.create({
					data: {
						id,
						userId: skill.userId,
						botId,
						name,
						description: redactSecrets(valid.skill.description),
						body: redactSecrets(valid.skill.body),
						tools: valid.skill.tools,
						enabled: draft ? false : skill.enabled,
						createdBy: "agent",
						status: draft ? "draft" : "active",
					},
				});
			} catch {
				record(name, "failed");
				continue;
			}
		}
		record(name, draft ? "created_draft" : "created");
	}
	return { dryRun: opts.dryRun, total: skills.length, counts, items };
}

/** Texto do relatório: contagens e nomes, sem conteúdo. */
export function formatSkillMigrationReport(report: SkillMigrationReport): string {
	const lines = [`${report.dryRun ? "[dry-run] " : ""}skills antigas: ${report.total}`];
	for (const [outcome, count] of Object.entries(report.counts)) lines.push(`  ${outcome}: ${count}`);
	for (const item of report.items) lines.push(`  - ${item.name}: ${item.outcome}`);
	return lines.join("\n");
}
