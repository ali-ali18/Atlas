// Um passo TOOLS: executa as chamadas do modelo SEMPRE pelo executor do contrato (único caminho).
// `read` roda em paralelo (lote de leituras seguidas); qualquer outro efeito roda em série e em ordem.
// Cada resultado fica em `snap.results` (o efeito já está no journal); chamada que pede aprovação ou
// handoff fica em `snap.parked` e o run estaciona. Na retomada só o que falta roda de novo.
import { storageSafe, type CallOutcome, type Executor } from "../contract/index.js";
import type { Tool } from "../tools/define-tool.js";
import type { KernelEvent, KernelSnapshot, PendingCall, ResumeInput } from "./types.js";

export type ToolStepEnv = {
	tools: ReadonlyMap<string, Tool>;
	executor: Executor;
	snap: KernelSnapshot;
	resume?: ResumeInput;
	emit: (event: KernelEvent) => Promise<void>;
	/** Ajusta a saída ao que cabe na janela sem perder nada (F1.8b: páginas + ponteiro). */
	fit: (call: PendingCall, text: string) => Promise<string>;
};

export const DENIED_TEXT = "The owner declined this action. Do not retry it; offer an alternative or ask what they would prefer.";
export const HANDOFF_DONE_TEXT = "The owner took over this step. Continue from the owner's latest message and check the result before relying on it.";

export function outcomeText(outcome: CallOutcome): string {
	switch (outcome.status) {
		case "ok":
			return outcome.summary;
		case "error":
			return `Error: ${outcome.error}${outcome.hint ? `\nHint: ${outcome.hint}` : ""}`;
		case "handoff":
		case "not_available":
			return outcome.message;
		case "interrupted_write":
		case "already_done":
			return outcome.hint;
		case "contract_error":
			return `Error: ${outcome.error}`;
		case "pending_approval":
		case "approval_invalid":
			return "Waiting for the owner to approve this action.";
	}
}

/** Ids repetidos no MESMO passo (provedor que numera tudo `call_0`) ganham sufixo `~n`, para o mapa de resultados e o par chamada/resultado não colidirem. */
export function uniqueCallIds<T extends { id: string }>(calls: readonly T[]): T[] {
	const seen = new Map<string, number>();
	return calls.map((c) => {
		const n = (seen.get(c.id) ?? 0) + 1;
		seen.set(c.id, n);
		return n === 1 ? c : { ...c, id: `${c.id}~${n}` };
	});
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Roda o que falta do passo. Devolve quantas chamadas vieram malformadas (tool desconhecida ou args que não são objeto). */
export async function runPending(env: ToolStepEnv): Promise<{ malformed: number }> {
	const { snap } = env;
	let malformed = 0;

	async function finish(call: PendingCall, status: string, text: string) {
		const content = await env.fit(call, storageSafe(text));
		snap.results[call.id] = content;
		await env.emit({ type: "tool_result", data: { callId: call.id, name: call.name, status, content } });
	}

	async function runOne(call: PendingCall): Promise<void> {
		const tool = env.tools.get(call.name);
		if (!tool || !isObject(call.args)) {
			malformed++;
			const available = [...env.tools.keys()].join(", ");
			const why = !tool ? `Unknown tool "${call.name}". Available tools: ${available}.` : `Arguments for ${call.name} must be a JSON object.`;
			return finish(call, "malformed", `Error: ${why}`);
		}
		const parked = snap.parked[call.id];
		let grant = undefined;
		if (parked) {
			if (parked.requestId && env.resume?.denied?.includes(parked.requestId)) {
				delete snap.parked[call.id];
				return finish(call, "denied", DENIED_TEXT);
			}
			if (parked.kind === "handoff") {
				if (!env.resume?.handoffDone?.includes(call.id)) return;
				delete snap.parked[call.id];
				return finish(call, "handoff_done", HANDOFF_DONE_TEXT);
			}
			grant = env.resume?.grants?.find((g) => g.requestId === parked.requestId);
			if (!grant) return;
		} else {
			await env.emit({ type: "tool_call", data: { callId: call.id, name: call.name, args: call.args, step: snap.step } });
		}
		const outcome = await env.executor.executeCall({ callId: call.id, step: snap.step, tool, args: call.args, ...(grant && { grant }) });
		if (outcome.status === "pending_approval" || outcome.status === "approval_invalid") {
			snap.parked[call.id] = { kind: "approval", requestId: outcome.request.id };
			await env.emit({ type: "card", data: { kind: "approval", callId: call.id, request: outcome.request } });
			return;
		}
		if (outcome.status === "handoff") {
			snap.parked[call.id] = { kind: "handoff" };
			await env.emit({ type: "card", data: { kind: "handoff", callId: call.id, userMessage: outcome.userMessage } });
			return;
		}
		delete snap.parked[call.id];
		if (outcome.status === "error" || outcome.status === "contract_error") snap.lastErrors[call.name] = outcome.error;
		else if (outcome.status === "ok") {
			delete snap.lastErrors[call.name];
			if (tool.endsTurn) snap.endedBy = call.id;
		}
		if (outcome.status === "ok" && outcome.receipt) {
			const { what, where, externalId, url } = outcome.receipt;
			await env.emit({ type: "receipt", data: { callId: call.id, name: call.name, what, ...(where && { where }), ...(externalId && { externalId }), ...(url && { url }) } });
		}
		await finish(call, outcome.status, outcomeText(outcome));
	}

	/** A chamada espera o dono (aprovação ou handoff): sem resultado e ainda estacionada. */
	const waiting = (call: PendingCall) => snap.results[call.id] === undefined && snap.parked[call.id] !== undefined;

	let reads: PendingCall[] = [];
	/** Devolve `true` se alguma leitura do lote ficou esperando o dono. */
	const flushReads = async (): Promise<boolean> => {
		const batch = reads;
		reads = [];
		await Promise.all(batch.map(runOne));
		return batch.some(waiting);
	};
	// A ordem declarada vale também diante de uma espera: depois da primeira chamada que estaciona nada mais
	// roda (efeito posterior nunca passa na frente da aprovação da anterior). As demais rodam na retomada, em ordem.
	for (const call of snap.pending) {
		if (snap.results[call.id] !== undefined) continue;
		const tool = env.tools.get(call.name);
		if (tool && tool.effectFor(call.args) === "read") reads.push(call);
		else {
			if (await flushReads()) return { malformed };
			await runOne(call);
			if (waiting(call)) return { malformed };
		}
	}
	await flushReads();
	return { malformed };
}
