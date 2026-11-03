import { describe, expect, it, vi } from "vitest";
import type { ChatTool } from "@workspace/llm";
import { closestToolNames, honestError, missingRequiredArgs, normalizeToolName, toolSignature, unknownToolMessage, withTransportRetry } from "./failures.js";
import { MAX_STEPS_SAFETY, UNATTENDED_MAX_STEPS, capStop, finalStepNote, reachedCap, stepLimitFor } from "./limits.js";
import { NUDGE_GLOBAL_CAP, createNudges, nudgeSignal, nudgeText } from "./nudges.js";
import { BLOCKED_REPEATED, COMPACTION_REPEAT_NOTE, PING_PONG_NOTE, POLL_EXEMPT, REPEAT_NOTE, SAME_ERROR_NOTE, createRepetitionGuard } from "./repetition.js";

describe("motor v3: limites", () => {
	it("sem humano = 40 passos; com humano = 200 de segurança; teto do dono vence os dois", () => {
		expect(stepLimitFor({ humanPresent: false })).toEqual({ maxSteps: UNATTENDED_MAX_STEPS, kind: "steps_unattended" });
		expect(stepLimitFor({ humanPresent: true })).toEqual({ maxSteps: MAX_STEPS_SAFETY, kind: "steps_safety" });
		expect(stepLimitFor({ humanPresent: false, ownerSteps: 80 })).toEqual({ maxSteps: 80, kind: "steps_owner" });
		expect(stepLimitFor({ humanPresent: true, ownerSteps: 10 })).toEqual({ maxSteps: 10, kind: "steps_owner" });
		// Acima do limite de segurança vale o de segurança (e nunca o 40 sem humano).
		expect(stepLimitFor({ humanPresent: true, ownerSteps: 500 }).maxSteps).toBe(MAX_STEPS_SAFETY);
		expect(stepLimitFor({ humanPresent: false, ownerSteps: 0 }).maxSteps).toBe(UNATTENDED_MAX_STEPS);
	});

	it("US$ e tempo só contam se o dono configurou", () => {
		const limit = stepLimitFor({ humanPresent: true });
		expect(reachedCap({ step: 3, limit, spentUsd: 999, activeMs: 9e9 })).toBeUndefined();
		expect(reachedCap({ step: 3, limit, spentUsd: 0.5, costCapUsd: 0.5, activeMs: 0 })).toBe("cost");
		expect(reachedCap({ step: 3, limit, spentUsd: 0, activeMs: 60_000, wallCapMs: 60_000 })).toBe("wall");
		expect(reachedCap({ step: 200, limit, spentUsd: 0, activeMs: 0 })).toBe("steps_safety");
	});

	it("nota do FINAL_STEP pede resposta honesta; sem humano pergunta se continua", () => {
		expect(finalStepNote("steps_unattended", true)).toMatch(/what is missing.*Do not call tools.*whether you should continue/s);
		expect(finalStepNote("steps_safety", false)).not.toMatch(/whether you should continue/);
		expect(capStop("steps_unattended", true)).toEqual({ reason: "budget_steps", detail: "v3_steps_unattended:items_open" });
		expect(capStop("repeated", false).reason).toBe("loop_repeat");
		expect(capStop("cost", false).reason).toBe("budget_cost");
	});
});

describe("motor v3: empurrões", () => {
	it("sinal só estrutural: finish reason, protocolo, vazio e lista do próprio modelo", () => {
		expect(nudgeSignal({ text: "abc", finishReason: "length" }, undefined)).toBe("truncated");
		expect(nudgeSignal({ text: "", finishReason: "tool_calls" }, undefined)).toBe("malformed");
		expect(nudgeSignal({ text: "  ", finishReason: "stop" }, undefined)).toBe("empty");
		expect(nudgeSignal({ text: "pronto", finishReason: "stop" }, [{ content: "a", status: "pending" }])).toBe("open_list");
		expect(nudgeSignal({ text: "pronto", finishReason: "stop" }, [{ content: "a", status: "completed" }])).toBeUndefined();
		// Texto que "anuncia" uma ação não é sinal: sem lista aberta, o turno acaba.
		expect(nudgeSignal({ text: "Vou abrir o Gemini na VM agora.", finishReason: "stop" }, undefined)).toBeUndefined();
	});

	it("teto por tipo (2,1,2,1) e global 3", () => {
		const nudges = createNudges();
		expect(nudges.take("empty")).toBe(true);
		expect(nudges.take("empty")).toBe(false);
		expect(nudges.take("truncated")).toBe(true);
		expect(nudges.take("truncated")).toBe(true);
		expect(nudges.take("malformed")).toBe(false); // global 3 atingido
		expect(Object.values(nudges.snapshot()).reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(NUDGE_GLOBAL_CAP);
		const restored = createNudges({ open_list: 1 });
		expect(restored.take("open_list")).toBe(false);
	});

	it("texto vai como user curto com [runtime]", () => {
		for (const kind of ["truncated", "empty", "malformed"] as const) expect(nudgeText(kind)).toMatch(/^\[runtime\] /);
		expect(nudgeText("open_list", [{ content: "Abrir Gemini", status: "in_progress" }, { content: "x", status: "completed" }])).toMatch(/1 open items: Abrir Gemini/);
	});
});

describe("motor v3: rede de repetição", () => {
	const rec = (guard: ReturnType<typeof createRepetitionGuard>, argsKey: string, result = "r", extra: Partial<{ poll: boolean; ok: boolean; errorKey: string }> = {}) =>
		guard.record({ argsKey, resultKey: result, poll: extra.poll ?? false, ok: extra.ok ?? true, ...(extra.errorKey ? { errorKey: extra.errorKey } : {}) });

	it("3ª igual = nota; 5ª não executa; 2 bloqueios = FINAL_STEP", () => {
		const guard = createRepetitionGuard();
		expect(rec(guard, "a").notes).toEqual([]);
		expect(rec(guard, "a").notes).toEqual([]);
		expect(rec(guard, "a").notes).toEqual([REPEAT_NOTE]);
		expect(guard.shouldBlock({ argsKey: "a", poll: false })).toBe(false);
		rec(guard, "a");
		expect(guard.shouldBlock({ argsKey: "a", poll: false })).toBe(true);
		expect(guard.reachedFinal()).toBe(false);
		expect(guard.shouldBlock({ argsKey: "a", poll: false })).toBe(true);
		expect(guard.reachedFinal()).toBe(true);
		expect(BLOCKED_REPEATED).toMatch(/^blocked: repeated/);
	});

	it("mesmos args com resultado diferente não é repetição", () => {
		const guard = createRepetitionGuard();
		for (let index = 0; index < 6; index += 1) expect(rec(guard, "a", `r${index}`).notes).toEqual([]);
		expect(guard.shouldBlock({ argsKey: "a", poll: false })).toBe(false);
	});

	it("tool poll fica isenta até 30 iguais seguidas", () => {
		const guard = createRepetitionGuard();
		for (let index = 1; index < POLL_EXEMPT; index += 1) {
			expect(rec(guard, "wait", "still", { poll: true }).notes).toEqual([]);
			expect(guard.shouldBlock({ argsKey: "wait", poll: true })).toBe(false);
		}
		expect(rec(guard, "wait", "still", { poll: true }).notes).toEqual([REPEAT_NOTE]);
		rec(guard, "wait", "still", { poll: true });
		expect(guard.shouldBlock({ argsKey: "wait", poll: true })).toBe(true);
	});

	it("ping-pong A,B,A,B (4 ciclos) recebe nota e o 5º ciclo é bloqueado", () => {
		const guard = createRepetitionGuard();
		const notes: string[] = [];
		for (let index = 0; index < 8; index += 1) notes.push(...rec(guard, index % 2 === 0 ? "A" : "B", `res${index}`).notes);
		expect(notes).toContain(PING_PONG_NOTE);
		rec(guard, "A", "res8");
		expect(guard.shouldBlock({ argsKey: "B", poll: false })).toBe(true);
	});

	it("mesmo erro no mesmo alvo 3x recebe nota", () => {
		const guard = createRepetitionGuard();
		const notes = [1, 2, 3].flatMap((index) => rec(guard, `click:${index}`, `err${index}`, { ok: false, errorKey: "click|ref9\u0000not found" }).notes);
		expect(notes).toEqual([SAME_ERROR_NOTE]);
	});

	it("guarda pós-compactação: repetir a última chamada de antes vira nota e, na 2ª vez, FINAL_STEP", () => {
		const guard = createRepetitionGuard();
		rec(guard, "x", "same");
		guard.markCompaction();
		const first = guard.record({ argsKey: "x", resultKey: "same", poll: false, ok: true });
		expect(first.notes).toContain(COMPACTION_REPEAT_NOTE);
		expect(first.final).toBe(false);
		expect(guard.record({ argsKey: "x", resultKey: "same", poll: false, ok: true }).final).toBe(true);
	});

	it("snapshot retoma os contadores", () => {
		const guard = createRepetitionGuard();
		for (let index = 0; index < 4; index += 1) rec(guard, "a");
		const resumed = createRepetitionGuard(JSON.parse(JSON.stringify(guard.snapshot())));
		expect(resumed.shouldBlock({ argsKey: "a", poll: false })).toBe(true);
	});
});

describe("motor v3: falhas", () => {
	const tool: ChatTool = {
		type: "function",
		function: { name: "navigate", description: "", parameters: { type: "object", properties: { url: { type: "string" }, mode: { enum: ["a", "b"] }, tags: { type: "array", items: { type: "string" } } }, required: ["url"] } },
	};

	it("nome: normalização determinística e até 3 próximos", () => {
		expect(normalizeToolName("Browser-Snapshot")).toBe("browser_snapshot");
		expect(normalizeToolName("browserSnapshot")).toBe("browser_snapshot");
		expect(closestToolNames("curent_time", ["current_time", "create_file", "web_search", "current_timezone"])).toEqual(["current_time"]);
		expect(closestToolNames("time", ["current_time", "current_timezone", "web_search"])).toEqual(["current_time", "current_timezone"]);
		expect(closestToolNames("publish_tiktok", ["current_time", "web_search"])).toEqual([]);
		expect(unknownToolMessage("publish_tiktok", [])).toMatch(/does not exist/);
	});

	it("argumento: assinatura curta e campos obrigatórios", () => {
		expect(toolSignature(tool)).toBe('navigate(url: string, mode?: "a" | "b", tags?: string[])');
		expect(missingRequiredArgs(tool, {})).toEqual(["url"]);
		expect(missingRequiredArgs(tool, { url: "x" })).toEqual([]);
	});

	it("erro honesto não vaza segredo", () => {
		expect(honestError(new Error("falhou com ghp_0123456789abcdefABCDEF0123"))).not.toContain("0123456789abcdefABCDEF");
	});

	it("transporte: 3 tentativas no modelo pedido, depois a cadeia configurada; erro não transitório sobe na hora", async () => {
		const transient = Object.assign(new Error("upstream 503"), { status: 503 });
		const tried: string[] = [];
		const result = await withTransportRetry(
			async (model) => {
				tried.push(model);
				if (model !== "fb2") throw transient;
				return "ok";
			},
			{ model: "m", fallbackModels: ["fb1", "fb2"], delivered: () => false, sleep: async () => undefined },
		);
		expect(result).toBe("ok");
		expect(tried).toEqual(["m", "m", "m", "fb1", "fb2"]);

		const auth = Object.assign(new Error("invalid api key"), { status: 401 });
		const call = vi.fn(async () => { throw auth; });
		await expect(withTransportRetry(call, { model: "m", fallbackModels: ["fb"], delivered: () => false, sleep: async () => undefined })).rejects.toBe(auth);
		expect(call).toHaveBeenCalledTimes(1);

		// Já saiu texto ao vivo: repetir duplicaria o balão.
		const cut = vi.fn(async () => { throw transient; });
		await expect(withTransportRetry(cut, { model: "m", delivered: () => true, sleep: async () => undefined })).rejects.toBe(transient);
		expect(cut).toHaveBeenCalledTimes(1);
	});
});
