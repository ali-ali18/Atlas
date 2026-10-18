/**
 * Migração de receitas -> Markdown com fixtures (Prisma em memória, sem banco).
 * Runner: `pnpm exec tsx --test src/skill-migration.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseSkillMarkdown, renderSkillMarkdown } from "@workspace/shared";
import { formatSkillMigrationReport, migrateSkillsToMarkdown, recipeToSkillFields, uniqueSkillName } from "./skill-migration.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

const recipe = (extra: object = {}) => ({
	capabilityKey: "weekly-report",
	title: "Relatório semanal",
	description: "Gera o relatório da semana a partir dos PRs.",
	triggers: ["relatório semanal"],
	preconditions: ["GitHub conectado"],
	inputs: [{ name: "repo", description: "repositório", required: true }],
	steps: [
		{ instruction: "Listar os PRs da semana", tool: "mcp__github__ListPRs" },
		{ instruction: "Resumir", tool: "web_search" },
	],
	postconditions: ["Resumo pronto"],
	failureModes: ["Sem acesso: avisar"],
	requiredTools: ["mcp__github__ListPRs", "web_search"],
	...extra,
});

let skills: FakeTable;
let versions: FakeTable;
let docs: FakeTable;
let installed: { restore: () => void };

const skill = (id: string, userId: string, key: string, extra: object = {}) => ({ id, userId, botId: "bot-1", capabilityKey: key, enabled: true, activeVersionId: `${id}-v1`, ...extra });
const version = (skillId: string, content: unknown, extra: object = {}) => ({ id: `${skillId}-v1`, skillId, number: 1, content, status: "active", revokedAt: null, ...extra });

beforeEach(() => {
	skills = new FakeTable([
		skill("s1", "user-a", "weekly-report"),
		skill("s2", "user-a", "weekly-report", { activeVersionId: null }), // colide e só tem rascunho
		skill("s3", "user-b", "weekly-report"), // outro dono: sem colisão
		skill("s4", "user-a", "sem-versao", { activeVersionId: null }),
		skill("s5", "user-a", "quebrada"),
		skill("s6", "default", "legado"),
		skill("s7", "user-a", "revogada", { activeVersionId: "s7-v1" }),
	]);
	versions = new FakeTable([
		version("s1", recipe()),
		version("s2", recipe(), { status: "draft", activeVersionId: null }),
		version("s3", recipe()),
		version("s5", { lixo: true }),
		version("s6", recipe()),
		version("s7", recipe(), { revokedAt: new Date(), status: "rejected" }),
	]);
	docs = new FakeTable();
	installed = installFakes({
		skill: skills,
		skillVersion: versions,
		skillDoc: docs,
		user: new FakeTable([{ id: "user-a" }, { id: "user-b" }]),
	});
});
afterEach(() => installed.restore());

test("renderiza a receita em markdown válido (round-trip no parser)", () => {
	const fields = recipeToSkillFields(recipe());
	assert.ok(fields);
	assert.match(fields.body, /## Steps\n1\. Listar os PRs da semana \(tool: `mcp__github__ListPRs`\)/);
	const md = renderSkillMarkdown({ name: "weekly-report", description: fields.description, tools: fields.tools, body: fields.body });
	const parsed = parseSkillMarkdown(md);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join(" "));
	assert.deepEqual(parsed.skill.tools, ["mcp__github__ListPRs", "web_search"]);
});

test("descrição longa é truncada em 300; receita sem passos é inválida", () => {
	assert.equal(recipeToSkillFields(recipe({ description: "x".repeat(500) }))?.description.length, 300);
	assert.equal(recipeToSkillFields(recipe({ steps: [] })), null);
	assert.equal(recipeToSkillFields("texto"), null);
});

test("uniqueSkillName usa sufixo -2, -3 respeitando 64 caracteres", () => {
	assert.equal(uniqueSkillName("a", new Set()), "a");
	assert.equal(uniqueSkillName("a", new Set(["a", "a-2"])), "a-3");
	assert.ok(uniqueSkillName("x".repeat(64), new Set(["x".repeat(64)])).length <= 64);
});

test("migra ativa, rascunho e colisão; preserva dono e escopo; descarta o resto", async () => {
	const report = await migrateSkillsToMarkdown({ dryRun: false });
	assert.deepEqual(report.counts, {
		created: 2,
		created_draft: 1,
		already_migrated: 0,
		skipped_no_version: 2,
		skipped_invalid: 1,
		skipped_unowned: 1,
		failed: 0,
	});
	const byId = (id: string) => docs.rows.find((r) => r.id === `migrated-${id}`)!;
	assert.equal(byId("s1").name, "weekly-report");
	assert.equal(byId("s1").status, "active");
	assert.equal(byId("s1").enabled, true);
	assert.equal(byId("s1").userId, "user-a");
	assert.equal(byId("s1").botId, "bot-1");
	assert.equal(byId("s1").createdBy, "agent");
	assert.equal(byId("s2").name, "weekly-report-2");
	assert.equal(byId("s2").status, "draft");
	assert.equal(byId("s2").enabled, false);
	assert.equal(byId("s3").name, "weekly-report");
	assert.equal(byId("s3").userId, "user-b");
	assert.equal(docs.rows.some((r) => r.userId === "default"), false);
	assert.equal(docs.rows.length, 3);
});

test("é idempotente: segunda execução não duplica", async () => {
	await migrateSkillsToMarkdown({ dryRun: false });
	const again = await migrateSkillsToMarkdown({ dryRun: false });
	assert.equal(again.counts.already_migrated, 3);
	assert.equal(again.counts.created + again.counts.created_draft, 0);
	assert.equal(docs.rows.length, 3);
});

test("dry-run não grava e o relatório não traz conteúdo", async () => {
	const report = await migrateSkillsToMarkdown({ dryRun: true });
	assert.equal(docs.rows.length, 0);
	assert.equal(report.counts.created, 2);
	const printed = formatSkillMigrationReport(report);
	assert.match(printed, /^\[dry-run\] skills antigas: 7/);
	assert.ok(!printed.includes("PRs da semana"));
	assert.ok(!printed.includes("user-a"));
});

test("segredo dentro da receita é redigido na migração", async () => {
	const token = `ghp_${"c".repeat(30)}`;
	versions.rows[0]!.content = recipe({ steps: [{ instruction: `usar ${token}`, tool: "web_search" }] });
	await migrateSkillsToMarkdown({ dryRun: false });
	assert.ok(!String(docs.rows.find((r) => r.id === "migrated-s1")?.body).includes(token));
});
