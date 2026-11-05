// Portas em memória para os testes do kernel: LLM roteirizado, Store com checkpoint/notas, eventos coletados.
import { createCapabilityRegistry } from "../capabilities/registry.js";
import { defineCapability, type Capability } from "../capabilities/define-capability.js";
import type { Tool } from "../tools/define-tool.js";
import type { Events, RunEvent } from "../ports/events.js";
import type { Llm, LlmChatRequest, LlmRole, LlmStreamEvent, LlmToolCall, LlmUsage } from "../ports/llm.js";
import type { Ports } from "../ports/index.js";
import type { Note, NoteStore, RunCheckpoint, RunStateStore, RunStatus } from "../ports/store.js";
import { runAgent } from "../kernel/run.js";
import type { RunAgentDeps, RunInput } from "../kernel/types.js";
import { chatPolicy } from "./contract-helpers.js";
import { FakeClock, FakeJournal, FakeReceipts, sha256 } from "./fake-ports.js";

export type Turn = LlmStreamEvent[] | ((request: LlmChatRequest) => LlmStreamEvent[]);
const usage = (u: Partial<LlmUsage> = {}): LlmUsage => ({ inputTokens: 100, outputTokens: 20, costUsd: 0.01, ...u });
const served = { provider: "fake", model: "fake-1" };

/** Roteiro de uma resposta do modelo. */
export function reply(opts: { text?: string; calls?: LlmToolCall[]; finish?: "stop" | "tool_calls" | "length" | "error"; usage?: Partial<LlmUsage>; chunks?: string[] }): LlmStreamEvent[] {
	const events: LlmStreamEvent[] = [];
	for (const chunk of opts.chunks ?? (opts.text ? [opts.text] : [])) events.push({ type: "text_delta", text: chunk });
	for (const call of opts.calls ?? []) events.push({ type: "tool_call", call });
	events.push({ type: "done", finishReason: opts.finish ?? (opts.calls?.length ? "tool_calls" : "stop"), usage: usage(opts.usage), served });
	return events;
}
export const call = (id: string, name: string, args: unknown): LlmToolCall => ({ id, name, args });

export class ScriptedLlm implements Llm {
	readonly requests: Array<LlmChatRequest & { role: LlmRole }> = [];
	constructor(private turns: Turn[], private windows: Partial<Record<LlmRole, number>> = {}) {}
	push(...turns: Turn[]) {
		this.turns.push(...turns);
	}
	async contextWindow(role: LlmRole) {
		return this.windows[role] ?? 1_000_000;
	}
	async *chat(request: LlmChatRequest) {
		this.requests.push(structuredClone({ ...request, signal: undefined }));
		const turn = this.turns.shift();
		if (!turn) throw new Error(`ScriptedLlm: no turn left for request #${this.requests.length} (role ${request.role})`);
		for (const event of typeof turn === "function" ? turn(request) : turn) yield event;
	}
	byRole(role: LlmRole) {
		return this.requests.filter((r) => r.role === role);
	}
}

export class MemoryRuns implements RunStateStore {
	checkpoints = new Map<string, RunCheckpoint>();
	statuses = new Map<string, RunStatus>();
	saves = 0;
	/** Simula queda: lança ao salvar o checkpoint de número N (1-based). */
	crashOnSave?: number;
	async saveCheckpoint(c: RunCheckpoint) {
		this.saves++;
		if (this.crashOnSave === this.saves) throw new Error("crash simulado");
		this.checkpoints.set(`${c.userId}:${c.runId}`, structuredClone(c));
	}
	async loadCheckpoint(userId: string, runId: string) {
		const c = this.checkpoints.get(`${userId}:${runId}`);
		return c ? structuredClone(c) : null;
	}
	async setStatus(userId: string, runId: string, status: RunStatus) {
		this.statuses.set(`${userId}:${runId}`, status);
	}
}

export class MemoryNotes implements NoteStore {
	items = new Map<string, Note>();
	async save(n: Note) {
		this.items.set(`${n.userId}:${n.id}`, structuredClone(n));
	}
	async get(userId: string, id: string) {
		return this.items.get(`${userId}:${id}`) ?? null;
	}
	async list(userId: string) {
		return [...this.items.values()].filter((n) => n.userId === userId);
	}
	async remove(userId: string, id: string) {
		this.items.delete(`${userId}:${id}`);
	}
}

export class EventLog implements Events {
	events: RunEvent[] = [];
	emit(e: RunEvent) {
		this.events.push(structuredClone(e));
	}
	of(type: string) {
		return this.events.filter((e) => e.type === type).map((e) => e.data as Record<string, any>);
	}
}

export function kernelHarness(turns: Turn[], opts: { tools?: Tool[]; capabilities?: Capability[]; windows?: Partial<Record<LlmRole, number>> } = {}) {
	const llm = new ScriptedLlm(turns, opts.windows);
	const runs = new MemoryRuns();
	const notes = new MemoryNotes();
	const journal = new FakeJournal();
	const receipts = new FakeReceipts();
	const log = new EventLog();
	const random = { bytes: (n: number) => new Uint8Array(n).fill(7) };
	const ports = { llm, store: { runs, notes, journal, receipts }, events: log, clock: new FakeClock(), random } as unknown as Ports;
	const registry = createCapabilityRegistry(opts.capabilities ?? [defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: opts.tools ?? [] })]);
	const input: RunInput = { stableSystem: "SYSTEM", contextSections: [], history: [{ kind: "owner", text: "faça isso" }] };
	const deps = (over: Partial<RunAgentDeps> = {}): RunAgentDeps => ({ runId: "run-1", ownerId: "owner-1", input, ports, registry, policy: chatPolicy, limits: {}, hash: sha256, ...over });
	return { llm, byRole: (r: LlmRole) => llm.byRole(r), runs, notes, journal, receipts, log, ports, registry, input, deps, run: (over: Partial<RunAgentDeps> = {}) => runAgent(deps(over)) };
}
