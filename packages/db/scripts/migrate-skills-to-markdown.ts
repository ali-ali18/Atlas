/**
 * K0.4 — migra as receitas antigas de skill para Markdown (`skill_docs`).
 * Operador: faça BACKUP do banco antes e rode primeiro com --dry-run.
 *
 *   cd apps/worker && pnpm exec tsx ../../packages/db/scripts/migrate-skills-to-markdown.ts --dry-run
 *   cd apps/worker && pnpm exec tsx ../../packages/db/scripts/migrate-skills-to-markdown.ts
 *
 * Idempotente. Imprime só contagens e nomes (nunca conteúdo). As tabelas
 * antigas não são alteradas.
 */
import { prisma } from "../src/client.js";
import { formatSkillMigrationReport, migrateSkillsToMarkdown } from "../src/skill-migration.js";

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	try {
		const report = await migrateSkillsToMarkdown({ dryRun });
		console.log(formatSkillMigrationReport(report));
		if (report.counts.failed > 0) process.exitCode = 1;
	} finally {
		await prisma.$disconnect();
	}
}

main().catch((error) => {
	console.error("migração falhou:", error instanceof Error ? error.message : "erro desconhecido");
	process.exitCode = 1;
});
