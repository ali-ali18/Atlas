import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventEnvelope, GithubWebhookTrigger, RoutineRecord } from "@workspace/shared";
import { parseRoutineTriggerJson } from "@workspace/shared";
import {
	createRoutineRun,
	findRecentRoutineRunByIdempotency,
	listGithubRoutinesForRepo,
	listRoutinesByHookKey,
	verifyHookSecret,
} from "@workspace/db";
import {
	enqueueRoutineEvent,
	type RoutineQueue,
} from "@workspace/queue";

export type MatchedHookRoutine = {
	routine: RoutineRecord;
	secretHash: string;
	maxBodyBytes: number;
};

export type MatchedGithubHookRoutine = {
	routine: RoutineRecord;
	trigger: GithubWebhookTrigger;
};

/**
 * Match v1: triggerJson.hookKey. O secretHash vem do triggerJson CRU (do db):
 * antes lia `routine.triggerJson`, que toRoutine() zera em rotinas event —
 * nenhuma rotina de webhook genérico casava ("Hook not found" sempre).
 */
export async function matchGenericHookRoutines(
	hookKey: string,
): Promise<MatchedHookRoutine[]> {
	return listRoutinesByHookKey(hookKey);
}

export function authorizeHookSecret(
	secret: string | undefined,
	matches: MatchedHookRoutine[],
): MatchedHookRoutine[] {
	if (!secret?.trim()) return [];
	return matches.filter((row) =>
		verifyHookSecret(secret.trim(), row.secretHash),
	);
}

/**
 * Endpoint único de webhook GitHub: acha, pelo `repo` do payload já
 * autenticado (secret compartilhado via env), todas as rotinas GitHub
 * (de qualquer usuário) que assinam aquele repo.
 */
export async function matchGithubHookRoutines(
	repo: string,
): Promise<MatchedGithubHookRoutine[]> {
	return listGithubRoutinesForRepo(repo);
}

/**
 * `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(secret, rawBody).
 * Comparação em tempo constante; nunca loga secret nem rawBody.
 */
export function verifyGithubSignature(
	secret: string,
	rawBody: string,
	signatureHeader: string | undefined,
): boolean {
	if (!signatureHeader) return false;
	const prefix = "sha256=";
	if (!signatureHeader.startsWith(prefix)) return false;
	const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
	const gotHex = signatureHeader.slice(prefix.length).trim();
	const expected = Buffer.from(expectedHex, "hex");
	const got = Buffer.from(gotHex, "hex");
	if (expected.length !== got.length) return false;
	return timingSafeEqual(expected, got);
}

/**
 * Cria RoutineRun + enqueue execute-routine (origin AgentRun = "routine").
 * Genérico o bastante pra qualquer provider (generic, github…) — só precisa
 * de `{ routine }`.
 */
export async function enqueueMatchedRoutineEvents(
	queue: RoutineQueue,
	routines: Array<{ routine: RoutineRecord }>,
	envelope: EventEnvelope,
): Promise<Array<{ routineId: string; routineRunId: string }>> {
	const runs: Array<{ routineId: string; routineRunId: string }> = [];
	for (const match of routines) {
		if (envelope.idempotencyKey) {
			const existing = await findRecentRoutineRunByIdempotency(
				match.routine.id,
				envelope.idempotencyKey,
			);
			if (existing) {
				runs.push({
					routineId: match.routine.id,
					routineRunId: existing.id,
				});
				continue;
			}
		}

		const routineRun = await createRoutineRun({
			routineId: match.routine.id,
			triggeredBy: "event",
			status: "queued",
			eventJson: envelope,
		});
		const ok = await enqueueRoutineEvent(queue, {
			routineId: match.routine.id,
			routineRunId: routineRun.id,
			event: envelope,
		});
		if (!ok) {
			console.error(
				`[routine-event] enqueue failed routine=${match.routine.id} run=${routineRun.id} provider=${envelope.provider} type=${envelope.type}`,
			);
			continue;
		}
		// Só ids/provider/tipo — nunca payload, headers nem segredos.
		console.log(
			`[routine-event] enqueued routine=${match.routine.id} run=${routineRun.id} provider=${envelope.provider} type=${envelope.type}`,
		);
		runs.push({
			routineId: match.routine.id,
			routineRunId: routineRun.id,
		});
	}
	return runs;
}
