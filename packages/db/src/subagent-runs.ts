import type { AgentRunStatus, RunUsage } from "@workspace/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { ACTIVE_STATUSES } from "./runs.js";

/**
 * Runs filhos de `delegate_task` (F5). O filho herda dono e bot do PAI lido no
 * banco (nunca de argumento do modelo), nasce sem `conversationId` (não entra
 * no índice "um run ativo por conversa" nem escreve na conversa do usuário) e
 * roda dentro do worker do pai, sem job próprio.
 */

export type SubagentRunRow = {
	id: string;
	userId: string;
	botId: string | null;
	parentRunId: string | null;
	origin: string;
	objective: string;
	status: string;
	resultText: string | null;
	error: string | null;
	usageJson: unknown;
	createdAt: Date;
	finishedAt: Date | null;
};

const SUBAGENT_ORIGIN = "subagent";
/** Objetivo do filho é só o `goal`; teto para não inflar a linha. */
const SUBAGENT_OBJECTIVE_MAX_CHARS = 2_000;

/** Cria o run filho. `null` se o pai não existe ou não é do `userId` (404 no chamador). */
export async function createSubagentRun(input: {
	parentRunId: string;
	userId: string;
	goal: string;
	model: string;
	maxSteps: number;
	budgetJson?: Prisma.InputJsonValue;
}): Promise<{ id: string } | null> {
	const parent = await prisma.agentRun.findFirst({
		where: { id: input.parentRunId, userId: input.userId },
		select: { id: true, userId: true, botId: true, parentRunId: true },
	});
	// Profundidade 1: filho de filho nunca existe.
	if (!parent || parent.parentRunId) return null;
	const row = await prisma.agentRun.create({
		data: {
			userId: parent.userId,
			botId: parent.botId,
			conversationId: null,
			origin: SUBAGENT_ORIGIN,
			parentRunId: parent.id,
			objective: input.goal.trim().slice(0, SUBAGENT_OBJECTIVE_MAX_CHARS),
			status: "running",
			model: input.model,
			maxSteps: input.maxSteps,
			budgetJson: input.budgetJson,
			startedAt: new Date(),
		},
		select: { id: true },
	});
	return row;
}

/** Fecha o run filho (só do dono, só origin subagent). `false` se não achou. */
export async function finishSubagentRun(input: {
	runId: string;
	userId: string;
	status: AgentRunStatus;
	resultText?: string;
	error?: string;
	usage?: RunUsage;
}): Promise<boolean> {
	const result = await prisma.agentRun.updateMany({
		where: { id: input.runId, userId: input.userId, origin: SUBAGENT_ORIGIN },
		data: {
			status: input.status,
			resultText: input.resultText ?? undefined,
			error: input.error ?? undefined,
			usageJson: input.usage as Prisma.InputJsonValue | undefined,
			finishedAt: new Date(),
		},
	});
	return result.count === 1;
}

/** Filhos de um run do usuário (outro dono → lista vazia). */
export async function listSubagentRuns(
	parentRunId: string,
	userId: string,
): Promise<SubagentRunRow[]> {
	return prisma.agentRun.findMany({
		where: { parentRunId, userId },
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			userId: true,
			botId: true,
			parentRunId: true,
			origin: true,
			objective: true,
			status: true,
			resultText: true,
			error: true,
			usageJson: true,
			createdAt: true,
			finishedAt: true,
		},
	});
}

/**
 * Resume do pai: filhos que ficaram `running` de uma execução interrompida não
 * têm mais quem os conclua. Falha-os antes de abrir os novos.
 */
export async function failOrphanSubagentRuns(
	parentRunId: string,
	userId: string,
): Promise<number> {
	const result = await prisma.agentRun.updateMany({
		where: {
			parentRunId,
			userId,
			origin: SUBAGENT_ORIGIN,
			status: { in: ACTIVE_STATUSES },
		},
		data: {
			status: "failed",
			error: "Interrompido: o run pai foi retomado.",
			finishedAt: new Date(),
		},
	});
	return result.count;
}


