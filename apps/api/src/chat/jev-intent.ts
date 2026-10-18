import { askJev } from "@workspace/llm";
import { detectJevIntents, NO_INTENTS, parseJevFeatureMode, type JevRuntime } from "@workspace/agent-runtime";
import type { JevMode } from "@workspace/shared";
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

/** Cancelar/confirmar em qualquer idioma para `maybeHandleConfirmedAction`. */
export function buildJevIntent(apiKey: string | undefined, env: NodeJS.ProcessEnv = process.env, resolvedMode?: JevMode): JevIntentFn | undefined {
	const rt = buildJevIntentRuntime(apiKey, env, resolvedMode);
	if (!rt) return undefined;
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
): Promise<JevIntentFn | undefined> {
	if (!apiKey) return undefined;
	const effective = await loadEffectiveConfig(userId, env, load);
	return buildJevIntent(apiKey, env, effective.jev.features.intent.value);
}
