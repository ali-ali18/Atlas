import type { CreateAgentRunRequest, CreateRunInputRequest, RunInputRecord } from "@workspace/shared";

/** A fila de entrada aceita no máximo 4 imagens por run (mesmo teto do db). */
export const FOLLOW_UP_MAX_IMAGES = 4;

export type FollowUpPlan = {
	objective: string;
	attachments: Array<{ artifactId: string }>;
	/** Inputs fundidos no objetivo do follow-up (queue primeiro, steer depois). */
	consume: RunInputRecord[];
	/** Não couberam no teto de imagens: seguem pendentes, agora no follow-up. */
	defer: RunInputRecord[];
};

/**
 * Decisão pura: quais inputs pendentes viram o objetivo do follow-up. Funde na
 * ordem (queue, depois steer) enquanto os anexos cabem; o primeiro input que
 * estouraria o teto e todos depois dele ficam em `defer`. Anexo nunca é
 * truncado em silêncio (consumido sem entregar), e texto vazio (só imagem) não
 * gera linhas em branco no objetivo.
 */
export function planFollowUp(
	queued: RunInputRecord[],
	steers: RunInputRecord[],
	maxImages = FOLLOW_UP_MAX_IMAGES,
): FollowUpPlan | null {
	const ordered = [...queued, ...steers];
	if (ordered.length === 0) return null;
	const consume: RunInputRecord[] = [];
	const attachments: Array<{ artifactId: string }> = [];
	let overflow = false;
	const defer: RunInputRecord[] = [];
	for (const item of ordered) {
		const own = item.attachments ?? [];
		if (!overflow && attachments.length + own.length <= maxImages) {
			consume.push(item);
			attachments.push(...own);
		} else {
			overflow = true;
			defer.push(item);
		}
	}
	// O primeiro input sempre cabe (cada input já vem limitado ao teto).
	const objective = consume
		.map((item) => item.content.trim())
		.filter((content) => content.length > 0)
		.join("\n\n");
	return { objective, attachments, consume, defer };
}

export type FollowUpDeps = {
	listQueued: () => Promise<RunInputRecord[]>;
	listSteers: () => Promise<RunInputRecord[]>;
	/** Cria o run e consome os inputs numa transação (db `createFollowUpRun`). */
	createFollowUp: (
		plan: FollowUpPlan,
	) => Promise<
		| { outcome: "created"; run: { id: string } }
		| { outcome: "already_consumed" }
		| { outcome: "merged"; runId: string }
	>;
	/** Enfileira com jobId determinístico; `false` = falhou (a reconciliação repete). */
	enqueueNextRun?: (runId: string) => Promise<boolean>;
	announce: (runId: string, plan: FollowUpPlan) => Promise<void>;
};

export type FollowUpOutcome =
	| "none"
	| "created"
	| "merged"
	| "already_consumed"
	| "enqueue_failed";

/**
 * Fim do run: inputs que sobraram viram um follow-up. Idempotência por passo:
 *  1. criar+consumir: transação única; reentrega vê inputs consumidos e sai.
 *  2. enfileirar: jobId `agent-run-<id>` determinístico (add duplicado é
 *     no-op); se o processo cair antes, o run `queued` sem `jobEnqueuedAt` é
 *     enfileirado pela reconciliação (listQueuedRunsMissingJob).
 *  3. anunciar: só UI, melhor esforço.
 * Nunca lança: o run principal já está concluído (ver W6).
 */
export async function chainFollowUp(deps: FollowUpDeps): Promise<FollowUpOutcome> {
	try {
		const plan = planFollowUp(await deps.listQueued(), await deps.listSteers());
		if (!plan) return "none";
		const created = await deps.createFollowUp(plan);
		if (created.outcome !== "created") return created.outcome;
		await deps.announce(created.run.id, plan).catch(() => undefined);
		if (!deps.enqueueNextRun) return "created";
		const queued = await deps.enqueueNextRun(created.run.id).catch(() => false);
		return queued ? "created" : "enqueue_failed";
	} catch (error) {
		console.error("chain queue input failed", error);
		return "none";
	}
}

export function followUpRequest(
	base: Pick<CreateAgentRunRequest, "model" | "conversationId" | "botId" | "origin">,
	plan: FollowUpPlan,
): CreateAgentRunRequest {
	return {
		messages: [{ role: "user", content: plan.objective }],
		model: base.model,
		conversationId: base.conversationId,
		botId: base.botId,
		origin: base.origin,
		objective: plan.objective,
		...(plan.attachments.length ? { attachments: plan.attachments } : {}),
		silent: true,
	};
}

/**
 * Pedido "para depois" que a triagem de mensagem guardou: entrada `queue` do run
 * em curso. O fim do run a encadeia como próximo turno (`chainFollowUp`). A chave
 * é estável por mensagem, então reentrega/resume não duplica; `silent` evita
 * espelhar de novo na conversa (a mensagem do usuário já foi gravada ao chegar).
 */
export function laterFollowUpInput(instruction: string, clientKey: string): CreateRunInputRequest {
	return { content: instruction, mode: "queue", author: "agent", clientKey, silent: true };
}
