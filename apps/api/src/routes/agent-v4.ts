import { Hono } from "hono";
import { z } from "zod";
import { CVV_TOOL_NAMES, isValidCvv } from "@workspace/shared";
import type { CvvEscrow } from "@workspace/agent";
import { decideAgentV4Request, findAgentV4Request, getAgentRunForUser, loadAgentV4Decisions, recordAgentV4CardResponse, requestResumeAgentRun, type AgentV4Decision, type AgentV4RequestView } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { enqueueAgentRunJob } from "./runs.js";

/**
 * Respostas do dono a pedidos do motor v4 (F2.6). Só existem linhas para runs que o v4 estacionou (flag
 * `ATLAS_ENGINE_V4` + conta liberada); com a flag desligada nenhuma rota abaixo encontra nada (404).
 *
 * CONTRATO (o cartão do app, em `apps/web`, chama estas duas rotas; ambas exigem sessão, `requireUser`):
 *
 * 1. Aprovação e handoff
 *    `POST /v1/agent-v4/runs/:runId/requests/:key/respond`
 *    - `:runId`: `runId` do evento `approval_request` / `handoff_request`.
 *    - `:key`: `requestId` do evento `approval_request`, ou `callId` do evento `handoff_request`.
 *    - body: `{ "decision": "approve" | "deny" | "handoff_done" }` (campo desconhecido = 400).
 *        approve        aprova (gera o grant ligado ao hash dos argumentos de quando o cartão foi mostrado)
 *      Pedido de COMPRA (`checkout`): `{ decision: "approve", cvv: "123" }`. O `cvv` (3 a 4 dígitos) é obrigatório nele e
 *      proibido nos outros (400 `cvv_required` / `cvv_not_accepted`). O valor NÃO é gravado em lugar nenhum: vai a um canal
 *      efêmero (Redis, selado, TTL de 15 min) ligado a este pedido e é consumido uma única vez. 503 `payment_unavailable`
 *      se o canal não existe (nada é aprovado).
 *        deny           "Agora não" (o kernel recebe `denied`; nada executa)
 *        handoff_done   o dono assumiu o passo (só para `handoff_request`)
 *      `approve`/`deny` valem só para pedido de aprovação; `handoff_done`, só para handoff (senão 400).
 *    - 200 `{ ok: true, status: "recorded" | "already", decision, resumed }`: decisão gravada (ou já era esta; cliques
 *      repetidos são idempotentes). `resumed: true` = o run foi reenfileirado e vai continuar. O run só é reenfileirado
 *      quando NÃO resta pedido pendente dele (o kernel processa todos de uma vez): enquanto houver, a resposta traz
 *      `pending: n` (quantos faltam) e `resumed: false`; o run continua quando o último for respondido. `resumed: false`
 *      sem `pending` = o run ainda não podia ser retomado (está parando): repita o mesmo POST em alguns segundos.
 *    - 400 corpo ou decisão inválidos. 404 run ou pedido inexistente OU de outro dono (indistinguíveis).
 *    - 409 `{ error: "conflict" }` o pedido já tem outra decisão; `{ error: "run_not_paused", retryable: true }` o run
 *      ainda não estacionou (cartão visto antes de o run parar): repita.
 *    - 410 `{ error: "expired" }` o pedido passou do prazo (24h) sem resposta: nada executa; o modelo é avisado ao retomar.
 *    - 503 fila de runs indisponível (nada é gravado).
 *
 * 2. Cartão de pergunta (`ask_owner`)
 *    `POST /v1/agent-v4/cards/:cardId/respond`
 *    - `:cardId`: `cardId` do evento `ask_owner`.
 *    - body: `{ "response": "answered" | "dismissed" }` ("Agora não" = `dismissed`).
 *    - 200 `{ ok: true, status: "recorded" | "already" }`. Não reenfileira nada: o run seguinte da conversa leva a
 *      resposta ao kernel. 404 cartão inexistente ou de outro dono. 409 já tem outra resposta, ou a oferta já foi
 *      encerrada (o dono falou de outra coisa e ela virou "ignorada").
 */
const decisionBody = z.object({ decision: z.enum(["approve", "deny", "handoff_done"]), cvv: z.string().max(8).optional() }).strict();
/** O CVV espera o run ser retomado por este tempo; passado dele, a compra pede o cartão de novo. */
export const CVV_TTL_MS = 15 * 60_000;
const cardBody = z.object({ response: z.enum(["answered", "dismissed"]) }).strict();

const PARAM_MAX = 500;
const validParam = (value: string): boolean => value.length > 0 && value.length <= PARAM_MAX;

/** Run que ainda pode estacionar e criar o pedido que o dono já viu no cartão. */
const RUN_STILL_PARKING: ReadonlySet<string> = new Set(["queued", "running", "retrying"]);

type RunQueue = Parameters<typeof enqueueAgentRunJob>[0];

export type AgentV4RouteDeps = {
	/** Fila de runs (a mesma de `/v1/runs/:id/resume`); `null` = indisponível. */
	queue: RunQueue | null;
	clock?: () => Date;
	/** Canal efêmero do CVV (F6.3). Sem ele, aprovar um pedido de compra responde 503 e nada é gravado. */
	cvvEscrow?: Pick<CvvEscrow, "deposit" | "discard"> | null;
};

export function createAgentV4Routes(deps: AgentV4RouteDeps) {
	const app = new Hono<AuthEnv>();
	const now = deps.clock ?? (() => new Date());
	// Descarte do CVV depositado: se falhar, o CVV só some pelo TTL; avisa no log (ids e tipo do erro, nunca o valor).
	const discardCvv = async (scope: { userId: string; runId: string; requestId: string }): Promise<void> => {
		await deps.cvvEscrow?.discard(scope).catch((error: unknown) => {
			console.warn(`[agent-v4] não consegui descartar o CVV do pedido (run=${scope.runId} pedido=${scope.requestId}): ${error instanceof Error ? error.name : "erro"}; ele expira sozinho pelo TTL`);
		});
	};

	app.post("/v1/agent-v4/runs/:runId/requests/:key/respond", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const runId = c.req.param("runId");
		const key = c.req.param("key");
		if (!validParam(runId) || !validParam(key)) return c.json({ error: "Not found" }, 404);
		const body = decisionBody.safeParse(await c.req.json().catch(() => null));
		if (!body.success) return c.json({ error: "Invalid body: expected { decision: 'approve' | 'deny' | 'handoff_done' }" }, 400);
		const decision: AgentV4Decision = body.data.decision;
		const cvv = body.data.cvv;

		// O escopo vem da sessão: run de outro dono é 404, igual a run inexistente.
		const run = await getAgentRunForUser(runId, userId);
		if (!run) return c.json({ error: "Not found" }, 404);
		if (!deps.queue) return c.json({ error: "Agent run queue unavailable" }, 503);

		// Só se grava a decisão com o run estacionado: clique que chega antes do `paused` pede para repetir, em vez de ficar
		// uma decisão gravada que ninguém retoma.
		let request: AgentV4RequestView;
		let status: "recorded" | "already";
		if (run.status === "paused") {
			// CVV (F6.3): só pedido de compra aprovado o leva. Valida o formato ANTES de qualquer efeito; o valor nunca é gravado
			// em banco nem log: vai só ao canal efêmero, ligado a ESTE pedido (dono + run + id do pedido, que embute o hash dos argumentos).
			const target = await findAgentV4Request(userId, runId, key);
			if (!target) return c.json({ error: "Not found" }, 404);
			const needsCvv = target.kind === "approval" && decision === "approve" && target.toolName !== null && (CVV_TOOL_NAMES as readonly string[]).includes(target.toolName);
			if (!needsCvv && cvv !== undefined) return c.json({ error: "cvv_not_accepted" }, 400);
			if (needsCvv && !isValidCvv(cvv)) return c.json({ error: "cvv_required" }, 400);
			const scope = { userId, runId, requestId: key };
			let deposited = false;
			if (needsCvv && target.state === "pending") {
				if (!deps.cvvEscrow) return c.json({ error: "payment_unavailable" }, 503);
				try {
					// `deposited` só é verdade se ESTE clique gravou (set if not exists): um CVV já depositado pelo primeiro clique
					// não é nosso para sobrescrever nem apagar.
					deposited = await deps.cvvEscrow.deposit(scope, cvv as string, CVV_TTL_MS);
				} catch {
					return c.json({ error: "payment_unavailable" }, 503);
				}
			}
			const outcome = await decideAgentV4Request(userId, runId, key, decision, now()).catch(async (error) => {
				if (deposited) await discardCvv(scope);
				throw error;
			});
			// Decisão recusada (conflito, vencido, inválido, inexistente) descarta o CVV que ESTE clique depositou. Em "already"
			// a decisão é a de um clique anterior, dono do CVV depositado: não se toca nele.
			if (deposited && outcome.status !== "recorded" && outcome.status !== "already") await discardCvv(scope);
			if (outcome.status === "not_found") return c.json({ error: "Not found" }, 404);
			if (outcome.status === "invalid_decision") return c.json({ error: `decision not valid for a ${outcome.kind} request` }, 400);
			if (outcome.status === "expired") return c.json({ error: "expired" }, 410);
			if (outcome.status === "conflict") return c.json({ error: "conflict" }, 409);
			request = outcome.request;
			status = outcome.status;
		} else {
			// Não está estacionado: só uma repetição idempotente de decisão já gravada é aceita.
			const existing = await findAgentV4Request(userId, runId, key);
			if (!existing) {
				// Cartão visto antes de o worker registrar o pedido: o run do PRÓPRIO dono ainda anda e vai estacionar. Pede para repetir
				// (o app já repete); run terminado ou pedido que nunca existirá segue 404. O run já veio filtrado por dono acima.
				if (RUN_STILL_PARKING.has(run.status)) return c.json({ error: "run_not_paused", retryable: true }, 409);
				return c.json({ error: "Not found" }, 404);
			}
			const target = { approve: "approved", deny: "denied", handoff_done: "done" }[decision];
			if (existing.state === target) return c.json({ ok: true, status: "already", decision, resumed: false });
			if (existing.state === "expired") return c.json({ error: "expired" }, 410);
			if (existing.state === "pending") return c.json({ error: "run_not_paused", retryable: true }, 409);
			return c.json({ error: "conflict" }, 409);
		}

		// Decisão gravada. Com outros pedidos do mesmo run ainda esperando o dono, o run segue estacionado: reenfileirar agora
		// só o faria reestacionar (e gastar uma volta do worker) sem ninguém ter decidido o resto (auditoria F2, R4).
		const { pending } = await loadAgentV4Decisions(userId, runId, now());
		if (pending > 0) return c.json({ ok: true, status, decision, resumed: false, pending, request: { kind: request.kind, state: request.state } });
		// Também em repetição, para curar uma queda entre gravar e reenfileirar.
		const resumed = await requestResumeAgentRun(runId).catch(() => null);
		const enqueued = resumed ? await enqueueAgentRunJob(deps.queue, resumed.id) : false;
		return c.json({ ok: true, status, decision, resumed: enqueued, request: { kind: request.kind, state: request.state } });
	});

	app.post("/v1/agent-v4/cards/:cardId/respond", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const cardId = c.req.param("cardId");
		if (!validParam(cardId)) return c.json({ error: "Not found" }, 404);
		const body = cardBody.safeParse(await c.req.json().catch(() => null));
		if (!body.success) return c.json({ error: "Invalid body: expected { response: 'answered' | 'dismissed' }" }, 400);
		const outcome = await recordAgentV4CardResponse(userId, cardId, body.data.response, now());
		if (outcome.status === "not_found") return c.json({ error: "Not found" }, 404);
		if (outcome.status === "conflict") return c.json({ error: "conflict" }, 409);
		return c.json({ ok: true, status: outcome.status });
	});

	return app;
}
