import { NoFallbackModelError, ProviderApiError } from "@workspace/llm";
import { describe, expect, it } from "vitest";
import { describeRunError, type UserErrorKind } from "./user-error.js";

const withStatus = (message: string, status: number, name = "OpenRouterError") => Object.assign(new Error(message), { status, name });
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

const table: Array<[string, unknown, UserErrorKind]> = [
	["status 429 estruturado", withStatus("Provider returned error", 429), "rate_limit"],
	["ProviderApiError rate_limited", new ProviderApiError("anthropic", 429, "rate_limited"), "rate_limit"],
	["texto rate-limited do OpenRouter", new Error("openai/gpt is temporarily rate-limited upstream."), "rate_limit"],
	["HTTP 429 com prefixo", new Error("falha HTTP 429"), "rate_limit"],
	["status 500", withStatus("boom", 500), "provider_down"],
	["status 503", withStatus("x", 503), "provider_down"],
	["ProviderApiError unavailable", new ProviderApiError("opencode-go", 503, "unavailable"), "provider_down"],
	["sem modelo de reserva", new NoFallbackModelError("opencode-go"), "provider_down"],
	["service unavailable em texto", new Error("Service Unavailable"), "provider_down"],
	["verificação de créditos", new Error("OpenRouter could not verify available credits for this request in time. Retry shortly."), "rate_limit"],
	["status 401", withStatus("No auth credentials found", 401), "auth"],
	["ProviderApiError auth_failed", new ProviderApiError("anthropic", 401, "auth_failed"), "auth"],
	["texto invalid api key", new Error("Incorrect API key provided"), "auth"],
	["status 402", withStatus("Payment Required", 402), "credits"],
	["ProviderApiError limit_exceeded", new ProviderApiError("opencode-go", 429, "limit_exceeded"), "credits"],
	["texto insufficient credits", new Error("insufficient credits"), "credits"],
	["status 413", withStatus("too large", 413), "context_too_long"],
	["400 com context length", withStatus("This model's maximum context length is 8192 tokens", 400), "context_too_long"],
	["texto context_length_exceeded", new Error("context_length_exceeded"), "context_too_long"],
	["400 genérico", withStatus("bad", 400), "bad_request"],
	["content filter", new Error("Response blocked by content_filter"), "content_filter"],
	["TimeoutError", timeout(), "timeout"],
	["timeout em causa", Object.assign(new Error("falhou"), { cause: timeout() }), "timeout"],
	["status 408", withStatus("Request Timeout", 408), "timeout"],
	["ECONNRESET", new Error("read ECONNRESET"), "network"],
	["fetch failed", new Error("fetch failed"), "network"],
	["ProviderApiError network_error", new ProviderApiError("anthropic", 0, "network_error"), "network"],
	["inglês desconhecido", new Error("Something odd happened in module xyz"), "unknown"],
	["pt-BR do runtime passa", new Error("limite de 100 passos esgotado"), "passthrough"],
];

describe("describeRunError", () => {
	it.each(table)("%s", (_name, error, kind) => {
		const described = describeRunError(error);
		expect(described.kind).toBe(kind);
		expect(described.message.length).toBeGreaterThan(10);
		expect(described.message).not.toMatch(/atlas/i);
	});

	it("auth cita o caminho em Configurações e não vaza a chave nem o texto cru", () => {
		const described = describeRunError(withStatus("Incorrect API key sk-live-123", 401));
		expect(described.message).toContain("Configurações › Provedores");
		expect(described.message).not.toContain("sk-live");
		expect(described.technical).toContain("sk-live-123");
	});

	it("rate limit sugere esperar ou trocar de modelo", () => {
		expect(describeRunError(withStatus("x", 429)).message).toBe("O provedor do modelo está limitando pedidos agora. Tente em alguns minutos ou troque de modelo.");
	});

	it("números soltos no texto não viram status (sem falso positivo)", () => {
		expect(describeRunError(new Error("Encontrei 5030 linhas e 4290 colunas")).kind).toBe("unknown");
		expect(describeRunError(new Error("Request id 4291 failed")).kind).toBe("unknown");
	});

	it("o status estruturado vence o texto", () => {
		expect(describeRunError(withStatus("rate limit exceeded", 401)).kind).toBe("auth");
	});

	it("motivo conhecido do ProviderApiError (imagens) mantém o texto do adaptador", () => {
		const error = new ProviderApiError("anthropic", 400, "bad_request", undefined, "no_image_support");
		expect(describeRunError(error).message).toBe(error.message);
	});

	it("texto inglês longo e técnico nunca passa cru", () => {
		const raw = "Error: " + "stack frame at module ".repeat(40);
		expect(describeRunError(new Error(raw)).kind).toBe("unknown");
	});
});

describe("describeRunError por idioma", () => {
	it("traduz o texto para o idioma resolvido e mantém pt-BR por padrão", () => {
		const error = withStatus("Provider returned error", 429);
		expect(describeRunError(error).message).toMatch(/limitando pedidos/);
		expect(describeRunError(error, "en-US").message).toBe("The model provider is limiting requests right now. Try again in a few minutes or switch models.");
		expect(describeRunError(error, "es-ES")).toMatchObject({ kind: "rate_limit", message: expect.stringMatching(/limitando las solicitudes/) });
		expect(describeRunError(new Error("kaboom"), "en-US").message).toMatch(/^Something went wrong/);
	});

	it("texto de sistema do runtime em qualquer idioma passa como está; inglês técnico continua genérico", () => {
		const loop = new Error("I got stuck repeating navigate with the same result, without progress.");
		expect(describeRunError(loop, "en-US")).toMatchObject({ kind: "passthrough", message: loop.message });
		const es = new Error("Me detuve porque la ejecución no avanzaba (detectado automáticamente).");
		expect(describeRunError(es, "es-ES").kind).toBe("passthrough");
		expect(describeRunError(new Error("random internal english failure"), "en-US").kind).toBe("unknown");
	});
});
