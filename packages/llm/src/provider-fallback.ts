import { parseModelRef, type ComputerUseEvent } from "@workspace/shared";
import {
	createProviderStreamChat,
	type ProviderStreamChat,
} from "./provider-router.js";
import { ProviderApiError, providerFailureKind, type ProviderFailureKind } from "./provider-errors.js";
import { ChatgptProviderError } from "./responses/errors.js";
/** Nenhum modelo de reserva utilizável: o run termina com esta mensagem em vez de ficar travado. */
export class NoFallbackModelError extends Error {
	readonly code = "no_fallback_model" as const;
	/** `specific`: mensagem do erro original (limite/chave), mais útil que o texto genérico; vai junto, resumida. */
	constructor(source: "chatgpt" | "opencode-go", specific?: string) {
		const generic = source === "opencode-go"
			? "O OpenCode Go não respondeu e não há outro modelo disponível. Tente de novo ou escolha outro modelo."
			: "O ChatGPT não respondeu e não há outro modelo disponível. Tente de novo ou escolha outro modelo.";
		super(specific ? `${specific} Não há outro modelo disponível; escolha outro modelo.` : generic);
		this.name = "NoFallbackModelError";
	}
}
export type ProviderFallbackNotice = Extract<
	ComputerUseEvent,
	{ type: "provider_fallback" }
>;
const limitCode = "subscription_sharing_usage_limit_exceeded";
const fallbackCodes = new Set([
	limitCode,
	"needs_login",
	"subscription_sharing_invalid_user",
	"subscription_sharing_not_eligible",
	"subscription_sharing_user_not_eligible",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_unsupported_capability",
]);
const goLimitCode = "opencode_go_limit_exceeded";
/** Falhas do OpenCode Go que justificam o modelo padrão: limite, chave recusada, indisponibilidade. */
type Failure = { error: Error; message: string; code: string; status: number; kind?: ProviderFailureKind; retryAfterMs?: number };
const chatFailure = (error: ChatgptProviderError): Failure => ({ error, message: error.message, code: error.code, status: error.status });
function goFailure(error: ProviderApiError): Failure {
	return {
		error,
		message: error.message,
		status: error.status,
		kind: providerFailureKind(error),
		...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
		code: error.code === "limit_exceeded" ? goLimitCode : error.code === "auth_failed" ? "opencode_go_auth_failed" : error.code === "unavailable" ? "opencode_go_unavailable" : "opencode_go_error",
	};
}
const goFallbackCodes = new Set([goLimitCode, "opencode_go_auth_failed", "opencode_go_unavailable"]);
/** Um stream nunca muda de provedor depois de texto entregue. Não recebe credenciais. */
export function createProviderFallbackStream(deps: {
	openrouter?: ProviderStreamChat;
	chatgpt: ProviderStreamChat;
	anthropic?: ProviderStreamChat;
	opencodeGo?: ProviderStreamChat;
	fallbackModel: string | null;
	/** `provider` distingue o limite de cada assinatura (chatgpt | opencode-go). */
	getLastLimitAt(provider?: "chatgpt" | "opencode-go"): Promise<number | null>;
	markLimitAt(at: number, provider?: "chatgpt" | "opencode-go"): Promise<void>;
	onFallback?(notice: ProviderFallbackNotice): void | Promise<void>;
	/** Cooldown por MODELO do OpenCode Go (limite do plano); sem isto cai no cooldown do provedor. */
	modelCooldown?: { until(model: string): Promise<number | null>; mark(model: string, untilMs: number): Promise<void> };
	/** O provedor do destino está utilizável (chave do OpenRouter, ChatGPT ligado, chave conectada)? */
	isModelAvailable?(model: string): Promise<boolean>;
	/** Modelo padrão da conta, tentado se o fallback do bot estiver indisponível. */
	accountDefaultModel?(): Promise<string | null>;
	/** Telemetria da classificação (sem chave nem corpo do upstream). */
	onClassified?(info: { model: string; kind: ProviderFailureKind; status: number }): void;
	cooldownMs?: number;
	now?: () => number;
}): ProviderStreamChat {
	if (
		deps.fallbackModel &&
		parseModelRef(deps.fallbackModel).provider !== "openrouter"
	)
		throw new RangeError("Fallback exige OpenRouter");
	const router = createProviderStreamChat({
		openrouter: deps.openrouter,
		chatgpt: deps.chatgpt,
		anthropic: deps.anthropic,
		opencodeGo: deps.opencodeGo,
	});
	const emitted = new Set<string>();
	/** Modelos do Go que falharam por indisponibilidade neste run: não insiste de novo, sem cooldown. */
	const failedThisRun = new Set<string>();
	const now = deps.now ?? Date.now;
	const cooldown = deps.cooldownMs ?? 15 * 60_000;
	return async (params, handlers = {}) => {
		const source = parseModelRef(params.model).provider;
		if (source !== "chatgpt" && source !== "opencode-go")
			return router(params, handlers);
		let delivered = false,
			ttft: number | undefined;
		const clock = params.clock ?? (() => performance.now()),
			start = clock();
		const wrapped = {
			...handlers,
			onDelta: (text: string) => {
				if (text) {
					delivered = true;
					ttft ??= clock() - start;
				}
				handlers.onDelta?.(text);
			},
		};
		let failure: Failure | undefined;
		try {
			if (source === "opencode-go" && deps.modelCooldown) {
				const until = await deps.modelCooldown.until(params.model);
				if (until !== null && until > now())
					failure = goFailure(new ProviderApiError("opencode-go", 429, "limit_exceeded"));
				else if (failedThisRun.has(params.model))
					failure = goFailure(new ProviderApiError("opencode-go", 503, "unavailable"));
			} else {
				const last = await deps.getLastLimitAt(source);
				if (last !== null && now() - last >= 0 && now() - last < cooldown)
					failure = source === "chatgpt" ? chatFailure(new ChatgptProviderError(429, limitCode)) : goFailure(new ProviderApiError("opencode-go", 429, "limit_exceeded"));
			}
			if (!failure) return await router(params, wrapped);
		} catch (error) {
			if (params.signal?.aborted) throw error;
			const typed =
				error instanceof ProviderApiError && error.provider === "opencode-go"
					? goFailure(error)
					: error instanceof ChatgptProviderError
					? chatFailure(error)
					: error instanceof Error &&
						  "code" in error &&
						  error.code === "needs_login"
						? chatFailure(new ChatgptProviderError(401, "needs_login"))
						: null;
			if (!typed || (!fallbackCodes.has(typed.code) && !goFallbackCodes.has(typed.code) && typed.status < 500))
				throw error;
			failure = typed;
			if (source === "opencode-go") {
				deps.onClassified?.({ model: params.model, kind: failure.kind ?? "other", status: failure.status });
				if (failure.code === goLimitCode) {
					// Limite do plano: cooldown só deste modelo (Retry-After se veio, senão o padrão).
					const wait = failure.retryAfterMs && failure.retryAfterMs > 0 ? failure.retryAfterMs : cooldown;
					if (deps.modelCooldown) await deps.modelCooldown.mark(params.model, now() + wait);
					else await deps.markLimitAt(now(), source);
				} else if (failure.code === "opencode_go_unavailable") {
					failedThisRun.add(params.model);
				}
			} else if (failure.code === limitCode) await deps.markLimitAt(now(), source);
		}
		if (!failure) throw new ChatgptProviderError(503);
		if (delivered) throw failure.error;
		const to = await pickFallback(params.model);
		if (!to) {
			if (!deps.fallbackModel && !deps.accountDefaultModel) throw failure.error;
			const specific = failure.kind === "plan_limit" || failure.kind === "auth" || failure.kind === "bad_request" || (source === "chatgpt" && fallbackCodes.has(failure.code));
			throw new NoFallbackModelError(source, specific ? failure.message : undefined);
		}
		const reason = failure.code;
		const id = `${params.model}:${to}:${reason}`;
		if (!emitted.has(id)) {
			await deps.onFallback?.({
				type: "provider_fallback",
				from: params.model,
				to,
				reason,
				message:
					source === "opencode-go"
						? `OpenCode Go indisponível para este modelo; usando ${to.split("/").pop()}`
						: `${failure.message} Usando ${to}.`,
			});
			emitted.add(id);
		}
		const result = await router({ ...params, model: to }, wrapped);
		return {
			...result,
			fallbackFrom: params.model,
			...(result.timing
				? {
						timing: {
							...result.timing,
							requestedModel: params.model,
							totalMs: Math.max(0, Math.round(clock() - start)),
							...(ttft === undefined
								? {}
								: { ttftMs: Math.max(0, Math.round(ttft)) }),
						},
					}
				: {}),
		};
	};
	/** Primeiro destino utilizável: fallback do bot, depois o modelo padrão da conta. */
	async function pickFallback(current: string): Promise<string | null> {
		const candidates: string[] = [];
		if (deps.fallbackModel) candidates.push(deps.fallbackModel);
		const fallbackDefault = await deps.accountDefaultModel?.().catch(() => null);
		if (fallbackDefault) candidates.push(fallbackDefault);
		for (const candidate of candidates) {
			if (candidate === current) continue;
			if (!deps.isModelAvailable || (await deps.isModelAvailable(candidate).catch(() => false))) return candidate;
		}
		return null;
	}
}
