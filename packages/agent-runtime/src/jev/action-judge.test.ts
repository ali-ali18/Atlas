import { describe, expect, it, vi } from "vitest";
import { buildActionJudgePrompt, judgeAction, parseActionVerdict, type ActionJudgeContext, type JudgedAction } from "./action-judge.js";
import type { JevComplete, JevRuntime } from "./decide.js";

const action: JudgedAction = { kind: "shell", cmd: "git push origin feat/x", cwd: "/workspace/repo" };
const context: ActionJudgeContext = {
	repo: "octo/hello",
	branch: "feat/x",
	userMessages: ["a", "b", "c", "suba a branch"],
	task: "Corrigir o login",
	steps: Array.from({ length: 12 }, (_, i) => `shell: passo ${i + 1}`),
	rule: { verdict: "risky", detail: "push sem destino" },
};

const runtime = (complete: JevComplete, mode: "off" | "shadow" | "on" = "on", onDecision?: JevRuntime["onDecision"]): JevRuntime => ({ modes: { actions: mode }, complete, onDecision });

describe("parseActionVerdict", () => {
	it("aceita JSON válido (também com cerca de código ou texto em volta)", () => {
		expect(parseActionVerdict('{"verdict":"allow","reason":"Combina com o pedido.","category":"ok"}')).toEqual({ verdict: "allow", reason: "Combina com o pedido.", category: "ok" });
		const fenced = "```json" + String.fromCharCode(10) + '{"verdict":"block","reason":"Envia segredos para fora."}' + String.fromCharCode(10) + "```";
		expect(parseActionVerdict(fenced)).toEqual({ verdict: "block", reason: "Envia segredos para fora." });
		expect(parseActionVerdict('{"verdict":"ASK","reason":"  Não tenho certeza. "}')).toEqual({ verdict: "ask", reason: "Não tenho certeza." });
	});

	it("JSON inválido devolve null (o chamador usa as regras)", () => {
		for (const text of ["", "sem json", "{verdict: allow}", "[1,2]", '"allow"', "{"]) expect(parseActionVerdict(text), text).toBeNull();
	});

	it("veredito desconhecido ou ausente vira ask, com o motivo se houver", () => {
		expect(parseActionVerdict('{"verdict":"maybe","reason":"Talvez."}')).toEqual({ verdict: "ask", reason: "Talvez." });
		const missing = parseActionVerdict('{"reason":"x"}');
		expect(missing?.verdict).toBe("ask");
		const noReason = parseActionVerdict('{"verdict":"nope"}');
		expect(noReason?.verdict).toBe("ask");
		expect(noReason?.reason).toMatch(/verificador/i);
	});

	it("block ou ask sem motivo não deixam o usuário sem explicação", () => {
		expect(parseActionVerdict('{"verdict":"block"}')).toMatchObject({ verdict: "ask" });
		expect(parseActionVerdict('{"verdict":"ask"}')?.reason).not.toBe("");
	});

	it("limita o tamanho do motivo", () => {
		const reason = "x".repeat(2_000);
		expect(parseActionVerdict(JSON.stringify({ verdict: "ask", reason }))!.reason.length).toBeLessThanOrEqual(400);
	});
});

describe("buildActionJudgePrompt", () => {
	it("leva as 3 últimas falas, a tarefa, os 8 últimos passos e a dica das regras", () => {
		const { system, user } = buildActionJudgePrompt({ action, context });
		expect(user).toContain("- suba a branch");
		expect(user).toContain("- b");
		expect(user).not.toContain("- a" + String.fromCharCode(10));
		expect(user).toContain("TASK: Corrigir o login");
		expect(user).toContain("shell: passo 12");
		expect(user).toContain("shell: passo 5");
		expect(user).not.toContain("shell: passo 4" + String.fromCharCode(10));
		expect(user).toContain("cmd: git push origin feat/x");
		expect(user).toContain("rule says outward/irreversible (push sem destino)");
		expect(system).toMatch(/Brazilian Portuguese/);
		expect(system).toMatch(/earlier denial/);
		expect(system).not.toMatch(/atlas/i);
	});

	it("redige segredos em tudo que vai ao modelo, inclusive com a redação do chamador", () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const { user } = buildActionJudgePrompt({
			action: { kind: "write", tool: "write_file", path: ".env", preview: `+TOKEN=${secret}` },
			context: { ...context, userMessages: [`meu token é ${secret}`], task: `usar ${secret}`, steps: [`shell: echo ${secret}`] },
			redact: (text) => text.split("valor-do-ambiente-123").join("[redigido]"),
		});
		expect(user).not.toContain(secret);
		const custom = buildActionJudgePrompt({ action: { kind: "shell", cmd: "echo valor-do-ambiente-123", cwd: "/workspace" }, context, redact: (text) => text.split("valor-do-ambiente-123").join("[redigido]") });
		expect(custom.user).not.toContain("valor-do-ambiente-123");
		expect(custom.user).toContain("[redigido]");
	});

	it("corta o que é grande demais", () => {
		const { user } = buildActionJudgePrompt({ action: { kind: "shell", cmd: "x".repeat(10_000), cwd: "/workspace" }, context });
		expect(user.length).toBeLessThan(6_000);
	});
});

describe("judgeAction", () => {
	it("devolve o parecer quando o modo é on", async () => {
		const complete = vi.fn<JevComplete>(async () => '{"verdict":"block","reason":"Envia segredos."}');
		const onDecision = vi.fn();
		const verdict = await judgeAction({ rt: runtime(complete, "on", onDecision), action, context });
		expect(verdict).toEqual({ verdict: "block", reason: "Envia segredos." });
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.calls[0]![0].timeoutMs).toBe(8_000);
		expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ feature: "actions", source: "jev" }));
	});

	it("sem cliente, desligado, erro, JSON inválido ou timeout: null", async () => {
		expect(await judgeAction({ rt: undefined, action, context })).toBeNull();
		expect(await judgeAction({ rt: { modes: { actions: "on" } }, action, context })).toBeNull();
		const complete = vi.fn<JevComplete>(async () => '{"verdict":"allow","reason":"ok"}');
		expect(await judgeAction({ rt: runtime(complete, "off"), action, context })).toBeNull();
		expect(complete).not.toHaveBeenCalled();
		const onDecision = vi.fn();
		expect(await judgeAction({ rt: runtime(async () => { throw new Error("x"); }, "on", onDecision), action, context })).toBeNull();
		expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ source: "unavailable" }));
		expect(await judgeAction({ rt: runtime(async () => "texto solto"), action, context })).toBeNull();
		vi.useFakeTimers();
		try {
			const pending = judgeAction({ rt: runtime(() => new Promise<string>(() => undefined)), action, context });
			await vi.advanceTimersByTimeAsync(9_000);
			expect(await pending).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shadow chama o modelo, registra, e não decide", async () => {
		const complete = vi.fn<JevComplete>(async () => '{"verdict":"block","reason":"x"}');
		expect(await judgeAction({ rt: runtime(complete, "shadow"), action, context })).toBeNull();
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("cancelamento do usuário propaga", async () => {
		const controller = new AbortController();
		const complete: JevComplete = async () => {
			controller.abort();
			throw new Error("abortado");
		};
		await expect(judgeAction({ rt: runtime(complete), action, context, signal: controller.signal })).rejects.toThrow();
	});
});
