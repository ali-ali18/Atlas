import { prisma } from "../src/client.js";
import { refreshSkillVersionEmbedding } from "../src/skills-search.js";

type PendingRow = {
	id: string;
	userId: string;
	botId: string;
};

async function main(): Promise<void> {
	try {
		const rows = await prisma.$queryRaw<PendingRow[]>`SELECT v."id" AS "id", s."userId" AS "userId", s."botId" AS "botId"
			FROM "skill_versions" v
			JOIN "skills" s ON s."id" = v."skillId"
			WHERE s."enabled" = true
				AND v."id" = s."activeVersionId"
				AND v."revokedAt" IS NULL
				AND v."embedding" IS NULL`;
		let ok = 0;
		let failed = 0;
		for (const row of rows) {
			const done = await refreshSkillVersionEmbedding(row.userId, row.botId, row.id);
			if (done) ok += 1;
			else failed += 1;
		}
		console.log(`backfill skills: ${ok} ok, ${failed} falhas`);
	} catch (error) {
		console.error(
			"backfill skills failed",
			error instanceof Error ? error.message : error,
		);
	} finally {
		await prisma.$disconnect().catch(() => undefined);
	}
}

void main();
