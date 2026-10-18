import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMMAND_ALLOWLIST } from "./dev-command-approval.js";

const dir = fileURLToPath(new URL("../../db/prisma/", import.meta.url));
const NAME = "20261024120000_dev_command_approval";

describe("migração de aprovação de comandos", () => {
	const sql = readFileSync(`${dir}migrations/${NAME}/migration.sql`, "utf8");

	it("vem depois das anteriores e só adiciona colunas", () => {
		const names = readdirSync(`${dir}migrations`).filter((n) => /^\d{14}_/.test(n)).sort();
		expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("20261023120000_dev_session_pr"));
		const statements = sql.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("--"));
		expect(statements).toHaveLength(3);
		for (const line of statements) {
			expect(line).toMatch(/^ALTER TABLE "(dev_environments|user_settings)" ADD COLUMN /);
			expect(line).not.toMatch(/DROP|RENAME|DELETE|UPDATE/);
		}
	});

	it("o padrão da lista liberada no SQL e no schema é o mesmo do código", () => {
		const schema = readFileSync(`${dir}schema.prisma`, "utf8");
		const fromSchema = /commandAllowlist\s+String\[\]\s+@default\(\[(.*)\]\)/.exec(schema)?.[1];
		expect(fromSchema).toBeDefined();
		expect(JSON.parse(`[${fromSchema}]`)).toEqual([...DEFAULT_COMMAND_ALLOWLIST]);
		const fromSql = /DEFAULT ARRAY\[(.*)\]::TEXT\[\]/.exec(sql)?.[1];
		expect(fromSql?.split(", ").map((v) => v.slice(1, -1))).toEqual([...DEFAULT_COMMAND_ALLOWLIST]);
	});
});

describe("migração do padrão Automático", () => {
	const name = "20261030120000_dev_approval_auto_default";
	const sql = readFileSync(`${dir}migrations/${name}/migration.sql`, "utf8");

	it("só zera allowlist (herdar), nos dois lugares, e deixa ask e auto", () => {
		const statements = sql.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("--"));
		expect(statements).toEqual([
			`UPDATE "dev_environments" SET "approvalMode" = NULL WHERE "approvalMode" = 'allowlist';`,
			`UPDATE "user_settings" SET "devApprovalMode" = NULL WHERE "devApprovalMode" = 'allowlist';`,
		]);
	});
});
