import { stoppedWithOpenWork, type RunFailureStep, type RunFailureToolCall, type RunFailureTrace } from "@workspace/shared";
import { mainCalls, offeredTools, type Trajectory } from "./trajectory.js";

/**
 * Monta o `RunFailureTrace` (classificador de falha do Motor v4) a partir de uma trajetória de eval.
 * Só preenche o que a trajetória grava de forma estrutural; o resto fica no padrão CONSERVADOR (sem falha),
 * para o classificador nunca acusar o que não dá para provar:
 *
 * - derivado: passos e tools (agrupados por `step`; sem `step`, um passo por chamada, depois dos numerados), `ok` (do resultado de mesmo id), `hidden` (tool chamada que
 *   nunca foi oferecida em passo `main`), `stop`, `repetitionBlocked` (motivo `loop_repeat`/`loop_stall_guard`),
 *   `endedWithoutTool` (último passo `main` respondeu sem tool), `openTaskItemsAtEnd` (1 se `stoppedWithOpenWork`;
 *   a contagem exata não é gravada, então é um piso), `transportErrors` (resultado de fonte `connector` com `ok:false`,
 *   sem código).
 * - NÃO derivável hoje (padrão): `notInCatalog`, `validationRejected`, `signatureVisible`, `errorCode`,
 *   `compactionHappened`, `reReadAfterCompactionEmpty`, `approvalCardForReadEffect`, `denyLaterAllowedByOwner` = falso/ausente;
 *   `staleTaskInjected` = falso; `declinedOffers` = []; `offeredTopics`/`abandonedTopics` ausentes.
 *   Cenários que medem insistência (ou o runtime, em produção) passam esses campos em `known`, que tem precedência.
 */
export function failureTraceFromTrajectory(trajectory: Trajectory, known: Partial<RunFailureTrace> = {}): RunFailureTrace {
	const offered = new Set(offeredTools(trajectory));
	const resultById = new Map(trajectory.toolResults.map((result) => [result.id, result]));

	// Chamadas com `step` agrupam por passo (são paralelas); sem `step`, cada uma é um passo próprio, depois dos
	// numerados e na ordem em que ocorreram. Antes `step ?? order` misturava número de passo com posição da chamada.
	const stepsByNumber = new Map<number, RunFailureToolCall[]>();
	const unnumbered: RunFailureStep[] = [];
	for (const call of trajectory.toolCalls) {
		const result = resultById.get(call.id);
		const entry: RunFailureToolCall = { name: call.name, ok: result?.ok ?? true };
		if (!offered.has(call.name)) entry.hidden = true;
		if (call.step === undefined) unnumbered.push({ toolCalls: [entry] });
		else stepsByNumber.set(call.step, [...(stepsByNumber.get(call.step) ?? []), entry]);
	}
	const steps: RunFailureStep[] = [...[...stepsByNumber.entries()].sort(([a], [b]) => a - b).map(([, toolCalls]) => ({ toolCalls })), ...unnumbered];

	const lastMain = mainCalls(trajectory).at(-1);
	const reason = trajectory.stop?.reason;
	const transportErrors = trajectory.toolResults.filter((result) => result.source === "connector" && !result.ok).map(() => ({ kind: "connector" as const }));

	return {
		steps,
		stop: trajectory.stop,
		transportErrors,
		staleTaskInjected: false,
		declinedOffers: [],
		openTaskItemsAtEnd: trajectory.stop && stoppedWithOpenWork(trajectory.stop) ? 1 : 0,
		endedWithoutTool: Boolean(lastMain?.response && !(lastMain.response.toolCalls?.length)),
		repetitionBlocked: reason === "loop_repeat" || reason === "loop_stall_guard",
		compactionHappened: false,
		reReadAfterCompactionEmpty: false,
		approvalCardForReadEffect: false,
		denyLaterAllowedByOwner: false,
		...known,
	};
}
