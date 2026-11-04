/**
 * Lições → fatos (motor v3, PR8c).
 *
 * Relatório (SOMENTE LEITURA, é o que se roda agora):
 *   cd apps/worker && pnpm exec tsx ../../packages/db/scripts/lessons-to-facts.ts --out /tmp/licoes.md [--user <id>] [--bot <id>]
 *
 * Aplicação (DESLIGADA: só com o ok do dono, depois de ler o relatório; escopo de um dono; não aposenta lição):
 *   cd apps/worker && pnpm exec tsx ../../packages/db/scripts/lessons-to-facts.ts --apply --user <id do dono> [--bot <id>]
 *
 * Faça BACKUP antes de aplicar. Nunca imprime texto de lição, só contagens; o conteúdo (já redigido) vai para o arquivo.
 */
import { writeFile } from "node:fs/promises";
import { prisma } from "../src/client.js";
import { applyLessonMigration, buildLessonMigrationReport, parseLessonMigrationArgs } from "../src/lesson-migration.js";

async function main(): Promise<void> {
	const args = parseLessonMigrationArgs(process.argv.slice(2));
	if (!args.ok) {
		console.error(args.error);
		process.exitCode = 2;
		return;
	}
	try {
		if (args.mode === "apply") {
			const results = await applyLessonMigration({ userId: args.userId, ...(args.botId ? { botId: args.botId } : {}) });
			for (const r of results) console.log(`bot ${r.botId}: ${r.written} fato(s) gravado(s), ${r.skipped} pulado(s), ${r.failed.length} falha(s)`);
			if (results.some((r) => r.failed.length > 0)) process.exitCode = 1;
			return;
		}
		const { owners, markdown } = await buildLessonMigrationReport({ ...(args.userId ? { userId: args.userId } : {}), ...(args.botId ? { botId: args.botId } : {}) });
		await writeFile(args.out, markdown, "utf8");
		console.log(`relatório gravado em ${args.out}: ${owners.length} bot(s) com lição ativa (nada foi gravado no banco)`);
	} finally {
		await prisma.$disconnect();
	}
}

main().catch((error) => {
	console.error("migração de lições falhou:", error instanceof Error ? error.message : "erro desconhecido");
	process.exitCode = 1;
});
