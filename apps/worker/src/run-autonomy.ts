import {
	DEFAULT_AUTONOMY_LEVEL,
	autonomyExpiryNotice,
	type EffectiveAutonomy,
} from "@workspace/shared";
import {
	appendConversationMessage,
	loadEffectiveAutonomy,
	type LoadedAutonomy,
} from "@workspace/db";

/**
 * Autonomia efetiva do run (F10). Quando a validade venceu, grava o fallback
 * (compare-and-set: só quem gravou avisa) e deixa UMA mensagem no chat. Run
 * sem humano (rotina/webhook) só resolve, sem gravar nem avisar; o próximo run
 * de chat faz isso. Falha de leitura cai no padrão (Equilibrado).
 */

export type RunAutonomyDeps = {
	load: (input: {
		userId: string;
		botId?: string | null;
		now: Date;
		applyExpiry?: boolean;
	}) => Promise<LoadedAutonomy>;
	notify: (conversationId: string, text: string) => Promise<unknown>;
};

const defaultDeps: RunAutonomyDeps = {
	load: loadEffectiveAutonomy,
	notify: (conversationId, text) => appendConversationMessage(conversationId, "assistant", text),
};

export async function resolveRunAutonomy(
	input: {
		userId: string;
		botId?: string | null;
		conversationId?: string | null;
		origin: string;
		now: Date;
	},
	deps: RunAutonomyDeps = defaultDeps,
): Promise<EffectiveAutonomy> {
	const unattended = input.origin === "routine" || input.origin === "webhook" || input.origin === "proactive";
	try {
		const loaded = await deps.load({
			userId: input.userId,
			botId: input.botId,
			now: input.now,
			applyExpiry: !unattended,
		});
		if (!unattended && input.conversationId) {
			for (const expiry of loaded.applied) {
				const text = autonomyExpiryNotice({
					scope: expiry.scope,
					botName: loaded.botName ?? undefined,
					to: expiry.to,
				});
				await deps.notify(input.conversationId, text).catch((error) => {
					console.error("autonomy expiry notice failed", error);
				});
			}
		}
		return loaded.policy;
	} catch (error) {
		console.error("load autonomy failed; using default", error);
		return { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] };
	}
}
