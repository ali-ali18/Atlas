import type { InspectRawApproval, InspectRawStep, LessonSlice } from "@workspace/shared";

/**
 * Sinais de aprendizado vindos da execução (sem LLM): ferramenta que falhou e depois deu certo, falha repetida
 * da mesma chamada e cartão de aprovação que falhou ou foi recusado. O sinal "o usuário corrigiu o bot" é outro
 * (decidido pelo Jev/modelo em `detectUserFeedback`). Funções puras.
 */

export type LessonSignal =
	| { kind: "user_feedback" }
	| { kind: "recovery"; tool: string; runId: string; step: number; failedArgs: string; error: string; succeededArgs: string }
	| { kind: "repeated_failure"; tool: string; runId: string; step: number; count: number; args: string; error: string }
	| { kind: "failed_action"; runId: string; title: string; detail: string }
	| { kind: "rejected_action"; runId: string; title: string };

export type RunStepsInput = { runId: string; steps: readonly InspectRawStep[]; approvals: readonly InspectRawApproval[] };

export type ToolOutcomeLine = { runId: string; step: number; tool: string; ok: boolean; args: string; summary: string };

export type DetectedSignals = {
	signals: LessonSignal[];
	outcomes: ToolOutcomeLine[];
	/** Para a checagem de proveniência (`lessonProvenanceProblem`). */
	slice: Pick<LessonSlice, "failureTexts" | "toolTexts">;
	/** Nomes de skill lidas (skill_read) com sucesso nos runs. */
	skillsRead: string[];
};

const IGNORED_TOOLS = new Set(["context_summary", "lesson_feedback", "update_task_list"]);
const ARGS_MAX = 300;
const SUMMARY_MAX = 1_200;
const OUTCOMES_MAX = 40;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function argsText(raw: unknown): string {
	if (raw === undefined || raw === null) return "";
	try {
		return (typeof raw === "string" ? raw : JSON.stringify(raw)).replace(/\s+/g, " ").slice(0, ARGS_MAX);
	} catch {
		return "";
	}
}

function skillNameOf(args: unknown): string | null {
	let value: unknown = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const name = record(value)?.name;
	return typeof name === "string" && name.trim() ? name.trim() : null;
}

type Call = { runId: string; step: number; sub: number; tool: string; ok: boolean; args: string; summary: string; rawArgs: unknown };

function callsOf(run: RunStepsInput): Call[] {
	const startByKey = new Map<string, Record<string, unknown>>();
	for (const step of run.steps) {
		if (step.type === "tool" && step.idempotencyKey) {
			const input = record(step.inputJson);
			if (input) startByKey.set(step.idempotencyKey, input);
		}
	}
	const calls: Call[] = [];
	for (const step of run.steps) {
		if (step.type !== "tool_result") continue;
		const input = record(step.inputJson) ?? (step.idempotencyKey ? startByKey.get(step.idempotencyKey) : undefined);
		const output = record(step.outputJson);
		const telemetry = record(output?.telemetry);
		const name = typeof input?.name === "string" ? input.name : typeof telemetry?.toolName === "string" ? telemetry.toolName : "";
		if (!name || IGNORED_TOOLS.has(name)) continue;
		const ok = !(step.status === "failed" || output?.ok === false);
		const summary = (typeof output?.summary === "string" ? output.summary : "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
		calls.push({ runId: run.runId, step: step.decisionIndex, sub: step.subIndex, tool: name, ok, args: argsText(input?.args), summary, rawArgs: input?.args });
	}
	return calls.sort((a, b) => a.step - b.step || a.sub - b.sub);
}

function approvalSignals(run: RunStepsInput): LessonSignal[] {
	const out: LessonSignal[] = [];
	for (const row of run.approvals) {
		let card: Record<string, unknown> | undefined;
		try {
			card = record(JSON.parse(row.content));
		} catch {
			continue;
		}
		if (!card || card.kind !== "confirm") continue;
		const title = typeof card.title === "string" ? card.title.slice(0, 200) : "";
		if (card.status === "failed") {
			const detail = typeof record(card.outcome)?.detail === "string" ? (record(card.outcome)!.detail as string).replace(/\s+/g, " ").slice(0, SUMMARY_MAX) : "";
			out.push({ kind: "failed_action", runId: run.runId, title, detail });
		} else if (card.status === "rejected") {
			out.push({ kind: "rejected_action", runId: run.runId, title });
		}
	}
	return out;
}

export function detectRunSignals(runs: readonly RunStepsInput[]): DetectedSignals {
	const signals: LessonSignal[] = [];
	const failureTexts: string[] = [];
	const toolTexts: string[] = [];
	const outcomes: ToolOutcomeLine[] = [];
	const skills = new Set<string>();

	for (const run of runs) {
		const calls = callsOf(run);
		for (const call of calls) {
			if (call.summary) toolTexts.push(call.summary);
			if (!call.ok && call.summary) failureTexts.push(call.summary);
			if (call.tool === "skill_read" && call.ok) {
				const name = skillNameOf(call.rawArgs);
				if (name) skills.add(name);
			}
			outcomes.push({ runId: call.runId, step: call.step, tool: call.tool, ok: call.ok, args: call.args, summary: call.summary.slice(0, 400) });
		}
		// Falhou e depois deu certo: a primeira falha de cada ferramenta com um sucesso posterior da mesma ferramenta.
		const recovered = new Set<string>();
		calls.forEach((call, index) => {
			if (call.ok || recovered.has(call.tool)) return;
			const later = calls.slice(index + 1).find((other) => other.tool === call.tool && other.ok);
			if (!later) return;
			recovered.add(call.tool);
			signals.push({ kind: "recovery", tool: call.tool, runId: run.runId, step: call.step, failedArgs: call.args, error: call.summary.slice(0, 300), succeededArgs: later.args });
		});
		// Mesma chamada (ferramenta + argumentos) falhando 2+ vezes.
		const counts = new Map<string, { call: Call; count: number }>();
		for (const call of calls) {
			if (call.ok) continue;
			const key = `${call.tool}\u0000${call.args}`;
			const current = counts.get(key);
			if (current) current.count += 1;
			else counts.set(key, { call, count: 1 });
		}
		for (const { call, count } of counts.values()) {
			if (count >= 2) signals.push({ kind: "repeated_failure", tool: call.tool, runId: run.runId, step: call.step, count, args: call.args, error: call.summary.slice(0, 300) });
		}
		for (const signal of approvalSignals(run)) {
			signals.push(signal);
			if (signal.kind === "failed_action" && signal.detail) failureTexts.push(signal.detail);
		}
	}
	return {
		signals,
		outcomes: outcomes.slice(-OUTCOMES_MAX),
		slice: { failureTexts, toolTexts },
		skillsRead: [...skills],
	};
}
