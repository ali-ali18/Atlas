import { askJev } from "@workspace/llm";
import { createReviewerClient, detectJevIntents, NO_INTENTS, parseJevFeatureMode, type JevRuntime, type ReviewerLlmDeps } from "@workspace/agent-runtime";
import { DEFAULT_MAINTENANCE_MODEL, type JevMode } from "@workspace/shared";
import { loadEffectiveConfig } from "./account-config.js";

/** `null` = Jev indisponível (off, falha ou timeout): o chamador cai no fallback. */
type JevIntentFn = (text: string) => Promise<{ cancel: boolean; confirm: boolean } | null>;

/** Runtime do Jev só para intenção (F11). `undefined` quando JEV_INTENT_MODE não é `on` ou falta a chave. */
export function buildJevIntentRuntime(apiKey: string | undefined, env: NodeJS.ProcessEnv = process.env, resolvedMode?: JevMode): JevRuntime | undefined {
	const mode = resolvedMode ?? parseJevFeatureMode(env.JEV_INTENT_MODE);
	if (!apiKey || mode === "off") return undefined;
	return {
		modes: { intent: mode },
		ask: (request) => askJev({ apiKey, state: request.state, questions: request.questions, timeoutMs: request.timeoutMs, signal: request.signal }),
	};
}

/**
 * Runtime do Jev (intenção) com o revisor da conta: modelo escolhido > Jev fixo no OpenRouter (chave do servidor) >
 * cadeia da manutenção (chaves próprias). `undefined` quando off ou sem nenhum caminho.
 */
export async function buildJevIntentRuntimeFor(
	userId: string,
	apiKey: string | undefined,
	env: NodeJS.ProcessEnv,
	mode: JevMode,
	deps: ReviewerLlmDeps = {},
): Promise<JevRuntime | undefined> {
	if (mode === "off") return undefined;
	const client = await createReviewerClient(
		{ userId, config: { openRouterApiKey: apiKey, summarizerModel: env.SUMMARIZER_MODEL?.trim() || DEFAULT_MAINTENANCE_MODEL, maintenanceModel: env.ATLAS_MAINTENANCE_MODEL?.trim() || undefined } },
		deps,
	).catch(() => null);
	if (!client?.available) return undefined;
	return { modes: { intent: mode }, ask: client.ask };
}

/** Cancelar/confirmar em qualquer idioma para `maybeHandleConfirmedAction`. */
export function buildJevIntent(apiKey: string | undefined, env: NodeJS.ProcessEnv = process.env, resolvedMode?: JevMode): JevIntentFn | undefined {
	const rt = buildJevIntentRuntime(apiKey, env, resolvedMode);
	return rt ? intentDetector(rt) : undefined;
}

function intentDetector(rt: JevRuntime): JevIntentFn {
	return async (text) => {
		const intents = await detectJevIntents({ rt, latestUserMessage: text });
		// `detectJevIntents` devolve o singleton NO_INTENTS quando off/falha/sem resposta.
		if (intents === NO_INTENTS) return null;
		return { cancel: intents.cancel, confirm: intents.confirm };
	};
}

/** Como `buildJevIntent`, mas com o modo de intenção da conta do usuário (usuário > env > off). */
export async function buildJevIntentFor(
	userId: string,
	apiKey: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	load?: Parameters<typeof loadEffectiveConfig>[2],
	reviewerDeps?: ReviewerLlmDeps,
): Promise<JevIntentFn | undefined> {
	const effective = await loadEffectiveConfig(userId, env, load);
	const rt = await buildJevIntentRuntimeFor(userId, apiKey, env, effective.jev.features.intent.value, reviewerDeps);
	return rt ? intentDetector(rt) : undefined;
}
