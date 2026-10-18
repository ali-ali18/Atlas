import {
	composeUsage,
	type UsageGroupRow,
	type UsageResponse,
} from "@workspace/shared";
import { prisma } from "./client.js";

type RawGroupRow = {
	botId: string | null;
	model: string;
	runs: number;
	cost: number | null;
	unknownCalls: number;
	planCalls: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
};

/**
 * Uso do dono no intervalo `[from, to)`, por bot e por modelo.
 *
 * Fonte: `AgentRun.usageJson` (nunca `AgentStep`). Só runs RAIZ
 * (`parentRunId IS NULL`): o `usageJson` do pai já soma o dos subagentes
 * (`delegate-task.ts` chama `ctx.addUsage`), contar o filho dobraria o custo.
 * Uma consulta só, filtrada por `"userId"` (usa `agent_runs_userId_createdAt_idx`)
 * e agrupada por (bot, modelo); o modelo é o que respondeu
 * (`telemetry.servedModel`) ou, sem ele, o pedido. `jsonb_typeof` protege o
 * cast contra valor que não seja número. `sum` ignora nulos: custo ausente
 * continua `null` (nunca 0) e `costUnknownCalls` mostra que o total é parcial.
 */
export async function getUsage(input: {
	userId: string;
	from: Date;
	to: Date;
}): Promise<Pick<UsageResponse, "totals" | "byBot" | "byModel">> {
	const { userId, from, to } = input;
	const raw = await prisma.$queryRaw<RawGroupRow[]>`
		SELECT
			"botId",
			coalesce(nullif("usageJson"->'telemetry'->>'servedModel', ''), "model") AS "model",
			count(*)::int AS "runs",
			sum(CASE WHEN jsonb_typeof("usageJson"->'costUsd') = 'number' THEN ("usageJson"->>'costUsd')::float8 END) AS "cost",
			coalesce(sum(CASE WHEN jsonb_typeof("usageJson"->'costUnknownCalls') = 'number' THEN ("usageJson"->>'costUnknownCalls')::float8 END), 0)::float8 AS "unknownCalls",
			coalesce(sum(CASE WHEN jsonb_typeof("usageJson"->'planCalls') = 'number' THEN ("usageJson"->>'planCalls')::float8 END), 0)::float8 AS "planCalls",
			coalesce(sum(CASE WHEN jsonb_typeof("usageJson"->'promptTokens') = 'number' THEN ("usageJson"->>'promptTokens')::float8 END), 0)::float8 AS "promptTokens",
			coalesce(sum(CASE WHEN jsonb_typeof("usageJson"->'completionTokens') = 'number' THEN ("usageJson"->>'completionTokens')::float8 END), 0)::float8 AS "completionTokens",
			coalesce(sum(CASE WHEN jsonb_typeof("usageJson"->'cachedTokens') = 'number' THEN ("usageJson"->>'cachedTokens')::float8 END), 0)::float8 AS "cachedTokens"
		FROM "agent_runs"
		WHERE "userId" = ${userId}
			AND "createdAt" >= ${from}
			AND "createdAt" < ${to}
			AND "parentRunId" IS NULL
			AND "usageJson" IS NOT NULL
		GROUP BY 1, 2`;

	const rows: UsageGroupRow[] = raw.map((row) => ({
		botId: row.botId,
		model: row.model,
		runs: Number(row.runs),
		costUsd: row.cost === null ? null : Number(row.cost),
		costUnknownCalls: Number(row.unknownCalls),
		planCalls: Number(row.planCalls),
		promptTokens: Number(row.promptTokens),
		completionTokens: Number(row.completionTokens),
		cachedTokens: Number(row.cachedTokens),
	}));

	const botIds = [...new Set(rows.flatMap((row) => (row.botId ? [row.botId] : [])))];
	const bots = botIds.length
		? await prisma.bot.findMany({
				where: { id: { in: botIds }, ownerId: userId },
				select: { id: true, name: true },
			})
		: [];
	return composeUsage({ rows, botNames: new Map(bots.map((bot) => [bot.id, bot.name])) });
}
