// Montagem e persistência do estado do run (checkpoint por passo).
import { buildRunMessages, channelMessage, createRunNonce, type RunNonce } from "../channels/index.js";
import type { CapabilityRegistry } from "../capabilities/index.js";
import { buildStablePrompt } from "../prompt/index.js";
import type { Ports } from "../ports/index.js";
import type { KernelState, KernelSnapshot, RunInput } from "./types.js";
import { freshGuard } from "./loop-guard.js";

export function initSnapshot(input: RunInput, ports: Ports, runtimeNotes: readonly string[] = [], registry?: CapabilityRegistry): KernelSnapshot {
	const nonce = createRunNonce(ports.random);
	return {
		v: 1,
		nonce,
		messages: buildRunMessages({ nonce, stableSystem: input.stableSystem ?? buildStablePrompt(registry), contextSections: input.contextSections, history: input.history, runtimeNotes }),
		ownerIdx: input.history.flatMap((h, i) => (h.kind === "owner" ? [2 + i] : [])),
		compacted: { noteIds: [], ownerTexts: [] },
		compactions: 0,
		step: 0,
		loadedIds: [],
		provenance: { untrustedReadInRun: false, sources: [], texts: [] },
		spentUsd: 0,
		stepsWithoutPrice: 0,
		lastText: "",
		pending: [],
		results: {},
		parked: {},
		guard: freshGuard(),
		lastErrors: {},
		malformedNow: 0,
		malformedStreak: 0,
		lastInputTokens: 0,
		tokensAtCount: 0,
	};
}

export function isSnapshot(value: unknown): value is KernelSnapshot {
	return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 1 && Array.isArray((value as { messages?: unknown }).messages);
}

export function addRuntimeNote(snap: KernelSnapshot, text: string): void {
	snap.messages.push(channelMessage(snap.nonce as RunNonce, { kind: "runtime", text }));
}

export async function saveCheckpoint(ports: Ports, ownerId: string, runId: string, state: KernelState, snap: KernelSnapshot): Promise<void> {
	// Sem clone: o laço espera esta chamada terminar antes de mexer no snapshot, e o adaptador serializa o `payload`
	// dentro da chamada (contrato em ports/store.ts). Custo que sobra: cada gravação serializa o estado inteiro.
	await ports.store.runs.saveCheckpoint({ runId, userId: ownerId, step: snap.step, state, payload: snap });
}

/**
 * Identificadores que o adaptador da porta `Store` lança quando o run deixou de ser deste worker: `lease_lost`
 * (outro worker assumiu; `message`/`code`) e `ResourceOwnershipError` (`name`). Comparação exata do identificador,
 * nunca de texto livre. Esses erros sobem sem tocar no estado do run: quem manda agora é o outro worker.
 */
export function isOwnershipLoss(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const e = error as { name?: unknown; code?: unknown; message?: unknown };
	return e.message === "lease_lost" || e.code === "lease_lost" || e.name === "ResourceOwnershipError" || e.code === "RESOURCE_NOT_FOUND";
}
