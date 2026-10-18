import { describe, expect, it } from "vitest";
import {
	capDiffText,
	capHistoryShellOutput,
	computeOpenDevJobs,
	DEV_SESSION_EVENT_TYPES,
	isDevSessionEvent,
	mergeTodoItems,
	normalizeShellCmd,
	parseTodoItems,
	sumDevTiming,
	type DevSessionEvent,
} from "./dev-session.js";

describe("parseTodoItems", () => {
	it("valida e normaliza itens", () => {
		expect(parseTodoItems([{ id: 1, content: " rodar testes ", status: "in_progress" }, { id: "b", content: "x" }])).toEqual([
			{ id: "1", content: "rodar testes", status: "in_progress" },
			{ id: "b", content: "x", status: "pending" },
		]);
	});
	it("rejeita status inválido, id repetido e conteúdo vazio", () => {
		expect(() => parseTodoItems([{ id: "a", content: "x", status: "feito" }])).toThrow(/status/);
		expect(() => parseTodoItems([{ id: "a", content: "x" }, { id: "a", content: "y" }])).toThrow(/repetido/);
		expect(() => parseTodoItems([{ id: "a", content: " " }])).toThrow(/content/);
		expect(() => parseTodoItems("x")).toThrow();
	});
});

describe("mergeTodoItems", () => {
	const prev = [
		{ id: "a", content: "A", status: "pending" as const },
		{ id: "b", content: "B", status: "pending" as const },
	];
	it("merge atualiza por id e acrescenta", () => {
		const out = mergeTodoItems(prev, [{ id: "a", content: "A", status: "completed" }, { id: "c", content: "C", status: "pending" }], true);
		expect(out.map((i) => [i.id, i.status])).toEqual([["a", "completed"], ["b", "pending"], ["c", "pending"]]);
	});
	it("sem merge substitui tudo", () => {
		expect(mergeTodoItems(prev, [{ id: "z", content: "Z", status: "pending" }], false)).toHaveLength(1);
	});
});

describe("eventos", () => {
	it("reconhece só os tipos de dev session", () => {
		const e: DevSessionEvent = { type: "shell_done", callId: "c", jobId: "j", exitCode: 0, durationMs: 5, endedReason: "exit" };
		expect(isDevSessionEvent(e)).toBe(true);
		expect(isDevSessionEvent({ type: "subagent_started" })).toBe(false);
		expect(DEV_SESSION_EVENT_TYPES).toHaveLength(10);
	});
	it("capDiffText limita e marca", () => {
		const big = Array.from({ length: 5000 }, (_, i) => `+linha ${i}`).join("\n");
		const out = capDiffText(big, 1000);
		expect(out.length).toBeLessThan(1100);
		expect(out).toMatch(/truncado/);
		expect(capDiffText("+a", 1000)).toBe("+a");
	});
});

describe("capHistoryShellOutput", () => {
	const out = (callId: string, chunk: string) => ({ type: "shell_output", payload: { callId, chunk } });
	it("mantém o fim da saída de cada comando e avisa do corte", () => {
		const events = [
			{ type: "shell_started", payload: { callId: "a" } },
			out("a", "11111"),
			out("a", "22222"),
			out("a", "33333"),
			out("b", "xx"),
			{ type: "shell_done", payload: { callId: "a" } },
		];
		const result = capHistoryShellOutput(events, 10);
		const a = result.filter((e) => e.type === "shell_output" && e.payload.callId === "a").map((e) => e.payload.chunk);
		expect(a).toEqual(["[início da saída omitido]\n22222", "33333"]);
		expect(result.filter((e) => e.payload.callId === "b")).toHaveLength(1);
		expect(result[0]!.type).toBe("shell_started");
		expect(result.at(-1)!.type).toBe("shell_done");
	});
	it("não mexe quando cabe", () => {
		const events = [out("a", "1"), out("a", "2")];
		expect(capHistoryShellOutput(events, 10)).toEqual(events);
	});
});

describe("computeOpenDevJobs / normalizeShellCmd", () => {
	const started = (callId: string, jobId: string) => ({ type: "shell_started", payload: { callId, jobId, cmd: "pnpm install", startedAt: "2026-10-17T10:00:00.000Z" } });
	const done = (callId: string, endedReason: string) => ({ type: "shell_done", payload: { callId, jobId: "x", endedReason } });

	it("background_running não fecha o job; qualquer outro fim fecha", () => {
		const open = computeOpenDevJobs([started("c1", "j1"), done("c1", "background_running"), started("c2", "j2"), done("c2", "lost"), started("c3", "j3"), done("c3", "exit")]);
		expect(open.map((job) => job.jobId)).toEqual(["j1"]);
		expect(open[0]!.startedAt).toBe(Date.parse("2026-10-17T10:00:00.000Z"));
	});

	it("normaliza espaços, quebras e terminadores", () => {
		expect(normalizeShellCmd("  pnpm  install\n--frozen-lockfile ;")).toBe("pnpm install --frozen-lockfile");
	});
});

describe("computeOpenDevJobs streamed", () => {
	it("marca streamed quando há shell_output do job", () => {
		const started = { type: "shell_started", payload: { callId: "c1", jobId: "j1", cmd: "x", startedAt: "2026-10-17T10:00:00.000Z" } };
		const out = { type: "shell_output", payload: { callId: "c1", jobId: "j1", chunk: "a" } };
		expect(computeOpenDevJobs([started])[0]!.streamed).toBeUndefined();
		expect(computeOpenDevJobs([started, out])[0]!.streamed).toBe(true);
	});
});

describe("sumDevTiming", () => {
	const run = (startedAt: number, extra: Record<string, number> = {}) => ({ startedAt, modelMs: 0, firstTokenMs: 0, toolsMs: 0, shellMs: 0, pollWaitMs: 0, setupMs: 0, approvalMs: 0, steps: 0, ...extra });
	it("soma os runs e conta a espera de aprovação até o início do run seguinte", () => {
		const total = sumDevTiming([
			run(2_000_000, { modelMs: 50_000, shellMs: 25_000, steps: 10 }),
			{ ...run(1_000_000, { modelMs: 80_000, setupMs: 40_000, steps: 8 }), approvalPendingAt: 1_500_000 },
		]);
		expect(total).toMatchObject({ modelMs: 130_000, shellMs: 25_000, setupMs: 40_000, steps: 18, approvalMs: 500_000 });
	});
	it("sem run seguinte (ainda esperando) ou com início anterior à pendência, não soma", () => {
		expect(sumDevTiming([{ ...run(1_000), approvalPendingAt: 5_000 }]).approvalMs).toBe(0);
		expect(sumDevTiming([{ ...run(1_000), approvalPendingAt: 9_000 }, run(2_000)]).approvalMs).toBe(0);
	});
});
