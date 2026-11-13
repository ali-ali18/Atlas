/**
 * Um turno do motor v4 dentro do processador de runs: prepara o contexto do banco, roda o motor, registra o que ficou
 * esperando o dono e, se o run estacionou, sinaliza `awaiting_owner` ao processador (que fecha o stream com `paused` e
 * solta o lease). Fica fora de `processors/agent-run.ts` para ser testado sem montar o processador inteiro.
 *
 * A ordem importa: o registro dos pedidos (`finish`) vem DEPOIS do motor (o checkpoint PARKED já foi gravado) e ANTES de
 * lançar a pausa; se cair no meio, a reentrega reconstrói os pedidos a partir do checkpoint (auditoria F2, B1).
 */
import { AgentRunPausedError, type RunComputerUseResult } from "@workspace/agent-runtime";
import type { V4EngineResult } from "./engine-v4.js";
import type { PreparedV4Run } from "./v4-run-context.js";

export async function runV4Turn(turn: { prepare: () => Promise<PreparedV4Run>; engine: (prepared: PreparedV4Run) => Promise<V4EngineResult> }): Promise<RunComputerUseResult> {
	const prepared = await turn.prepare();
	const out = await turn.engine(prepared);
	// Pedidos que ficaram esperando o dono ganham prazo e viram respondíveis pela API (`/v1/agent-v4/...`); respostas de cartão entregues.
	await prepared.finish({ parked: out.parked });
	// Estacionado: a retomada recarrega o checkpoint v4 e monta o `ResumeInput` (grants, recusas, expirados) com o que o dono decidiu.
	if (out.parked) throw new AgentRunPausedError("awaiting_owner");
	return { text: out.text, model: out.model, hitWall: out.hitWall, usage: out.usage, stop: out.stop };
}
