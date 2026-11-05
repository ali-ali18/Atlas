// Montagem e persistência do estado do run (checkpoint por passo).
import { buildRunMessages, channelMessage, createRunNonce, type RunNonce } from "../channels/index.js";
import type { Ports } from "../ports/index.js";
import type { KernelState, KernelSnapshot, RunInput } from "./types.js";
import { freshGuard } from "./loop-guard.js";

export function initSnapshot(input: RunInput, ports: Ports, runtimeNotes: readonly string[] = []): KernelSnapshot {
	const nonce = createRunNonce(ports.random);
	return {
		v: 1,
		nonce,
		messages: buildRunMessages({ nonce, stableSystem: input.stableSystem, contextSections: input.contextSections, history: input.history, runtimeNotes }),
		ownerIdx: input.history.flatMap((h, i) => (h.kind === "owner" ? [2 + i] : [])),
		compacted: { noteIds: [], ownerTexts: [] },
		compactions: 0,
		step: 0,
		loadedIds: [],
		provenance: { untrustedReadInRun: false, sources: [], texts: [] },
		spentUsd: 0,
		stepsWithoutPrice: 0,
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
	await ports.store.runs.saveCheckpoint({ runId, userId: ownerId, step: snap.step, state, payload: structuredClone(snap) });
}
