import { NoFallbackModelError, ProviderApiError } from "@workspace/llm";
import { describe, expect, it } from "vitest";
import {
	AgentRunCancelledError,
	AgentRunLoopDetectedError,
	AgentRunPausedError,
	LeaseLostError,
	PermanentRunError,
	classifyRunError,
	errorFromAbortSignal,
} from "./errors.js";
import { modelCallSignal } from "@workspace/llm";

describe("classifyRunError", () => {
	it("marca cancelamento", () => {
		expect(classifyRunError(new AgentRunCancelledError())).toBe("cancelled");
	});

	it("marca pausa sem tratar como cancelamento", () => {
		expect(classifyRunError(new AgentRunPausedError())).toBe("paused");
	});

	it("marca lease perdido como lease_lost, não transient genérico", () => {
		expect(classifyRunError(new LeaseLostError())).toBe("lease_lost");
	});

	it("marca 429 e rede como transitório", () => {
		expect(classifyRunError(new Error("429 rate limit"))).toBe("transient");
		expect(classifyRunError(new Error("ECONNRESET"))).toBe("transient");
	});

	it("marca erros de conexão do banco (Prisma/pg) como transitórios", () => {
		for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024"]) {
			const error = Object.assign(new Error("Prisma failure"), { code });
			expect(classifyRunError(error)).toBe("transient");
		}
		const wrapped = new Error("run failed", {
			cause: Object.assign(new Error("x"), { code: "P1017" }),
		});
		expect(classifyRunError(wrapped)).toBe("transient");
		for (const message of [
			"Can't reach database server at `db:5432`",
			"Connection terminated unexpectedly",
			"Connection terminated",
			"Timed out fetching a new connection from the connection pool",
			"server closed the connection unexpectedly",
		]) {
			expect(classifyRunError(new Error(message))).toBe("transient");
		}
	});

	it("erro de banco de regra (ex.: unique P2002) continua permanente", () => {
		const error = Object.assign(new Error("Unique constraint failed"), {
			code: "P2002",
		});
		expect(classifyRunError(error)).toBe("permanent");
	});

	it("marca rate-limit com hífen/sem espaço como transitório", () => {
		expect(
			classifyRunError(
				new Error("openai/gpt-5.6-luna is temporarily rate-limited upstream."),
			),
		).toBe("transient");
		expect(classifyRunError(new Error("RATELIMIT exceeded"))).toBe(
			"transient",
		);
	});

	it("marca timeout de verificação de créditos da OpenRouter como transitório", () => {
		expect(
			classifyRunError(
				new Error(
					"OpenRouter could not verify available credits for this request in time. Retry shortly.",
				),
			),
		).toBe("transient");
	});

	it("mantém saldo insuficiente como permanente (sem retry inútil)", () => {
		expect(
			classifyRunError(new Error("402 Payment Required: insufficient credits")),
		).toBe("permanent");
	});

	it("marca o restante como permanente", () => {
		expect(classifyRunError(new PermanentRunError("bad request"))).toBe(
			"permanent",
		);
		expect(classifyRunError(new Error("modelo inválido"))).toBe("permanent");
	});

	it("marca loop detectado como permanente (sem retry inútil)", () => {
		expect(
			classifyRunError(new AgentRunLoopDetectedError("Travei repetindo x")),
		).toBe("permanent");
	});

	it("marca timeout do modelo como transitório, nunca cancelado", () => {
		const timeout = new Error("The operation was aborted due to timeout");
		timeout.name = "TimeoutError";
		expect(classifyRunError(timeout)).toBe("transient");
	});

	it("sinal do modelo aborta no timeout curto", async () => {
		const signal = modelCallSignal(undefined, 20);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal?.aborted).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(signal?.aborted).toBe(true);
	});

	it("AbortError nativo sem motivo de usuário não é cancelled", () => {
		const abort = new Error("The operation was aborted");
		abort.name = "AbortError";
		expect(classifyRunError(abort)).toBe("transient");
	});

	it("AbortError com causa TimeoutError é transitório", () => {
		const timeout = new Error("The operation was aborted due to timeout");
		timeout.name = "TimeoutError";
		const abort = new Error("aborted");
		abort.name = "AbortError";
		abort.cause = timeout;
		expect(classifyRunError(abort)).toBe("transient");
	});

	it("mensagem contendo cancel não vira cancelled sozinha", () => {
		expect(classifyRunError(new Error("failed to cancel sandbox"))).toBe(
			"permanent",
		);
	});

	it("errorFromAbortSignal respeita a origem do reason", () => {
		const user = new AbortController();
		user.abort(new AgentRunCancelledError("pedido do usuário"));
		expect(errorFromAbortSignal(user.signal)).toBeInstanceOf(
			AgentRunCancelledError,
		);

		const lease = new AbortController();
		lease.abort(new LeaseLostError());
		expect(errorFromAbortSignal(lease.signal)).toBeInstanceOf(LeaseLostError);

		const timeout = new AbortController();
		const reason = new Error("The operation was aborted due to timeout");
		reason.name = "TimeoutError";
		timeout.abort(reason);
		expect(errorFromAbortSignal(timeout.signal).name).toBe("TimeoutError");
	});

	it("worker: cancel do usuário via signal vira cancelled; timeout e abort genérico não", () => {
		const user = new AbortController();
		user.abort(new AgentRunCancelledError());
		expect(classifyRunError(errorFromAbortSignal(user.signal))).toBe(
			"cancelled",
		);

		const timeout = new AbortController();
		const reason = new Error("The operation was aborted due to timeout");
		reason.name = "TimeoutError";
		timeout.abort(reason);
		expect(classifyRunError(errorFromAbortSignal(timeout.signal))).toBe(
			"transient",
		);

		const stray = new AbortController();
		stray.abort();
		expect(classifyRunError(errorFromAbortSignal(stray.signal))).toBe(
			"transient",
		);
	});

	it("erro de provedor: plano/chave/requisição ruim terminam o run; falha do upstream é transitória (limitada pelos attempts)", () => {
		expect(classifyRunError(new ProviderApiError("opencode-go", 429, "limit_exceeded"))).toBe("permanent");
		expect(classifyRunError(new ProviderApiError("anthropic", 401, "auth_failed"))).toBe("permanent");
		expect(classifyRunError(new ProviderApiError("anthropic", 400, "bad_request"))).toBe("permanent");
		expect(classifyRunError(new ProviderApiError("opencode-go", 429, "unavailable"))).toBe("transient");
		expect(classifyRunError(new ProviderApiError("anthropic", 503, "unavailable"))).toBe("transient");
		expect(classifyRunError(new ProviderApiError("anthropic", 429, "rate_limited"))).toBe("transient");
		expect(classifyRunError(new ProviderApiError("anthropic", 0, "network_error"))).toBe("transient");
		expect(classifyRunError(new ProviderApiError("anthropic", 200, "stream_interrupted"))).toBe("transient");
		expect(classifyRunError(new NoFallbackModelError("opencode-go"))).toBe("permanent");
		expect(classifyRunError(new Error("falha HTTP 503"))).toBe("transient");
	});
});

describe("classifyRunError: status estruturado e padrões ancorados", () => {
	it("status HTTP do erro decide antes do texto", () => {
		const e = (status: number) => Object.assign(new Error("x"), { status });
		expect(classifyRunError(e(429))).toBe("transient");
		expect(classifyRunError(e(500))).toBe("transient");
		expect(classifyRunError(e(401))).toBe("permanent");
		expect(classifyRunError(e(400))).toBe("permanent");
	});

	it("números e palavras soltas no texto não reenfileiram o run", () => {
		expect(classifyRunError(new Error("Encontrei 5030 linhas"))).toBe("permanent");
		expect(classifyRunError(new Error("o campo network está vazio"))).toBe("permanent");
		expect(classifyRunError(new Error("recurso unavailable na lista"))).toBe("permanent");
		expect(classifyRunError(new Error("falha HTTP 503"))).toBe("transient");
		expect(classifyRunError(new Error("Service Unavailable"))).toBe("transient");
	});
});
