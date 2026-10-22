import { readProactiveSettings, type ProactiveSettings, type RoutineNotifyMode } from "@workspace/shared";

/**
 * Modo proativo de UM run: só o bot principal, com o modo ligado, em chat próprio ou
 * nos runs proativos (reflexão e lembrete). Grupo e demais origens ficam de fora.
 */
export function resolveProactiveForRun(input: {
	origin: string;
	isGroupRun: boolean;
	isPrimary: boolean;
	policyJson: unknown;
	/** Fuso das configurações da conta: manda sobre o que o bot guardou. */
	accountTimezone?: string | null;
}): { settings: ProactiveSettings } | undefined {
	if (input.isGroupRun || !input.isPrimary) return undefined;
	if (input.origin !== "chat" && input.origin !== "proactive") return undefined;
	const settings = readProactiveSettings(input.policyJson, input.accountTimezone);
	return settings.enabled ? { settings } : undefined;
}

/**
 * Push avulso (`notify_user` só-push) de UM run: rotina "só importante" (o fim do run não avisa
 * sozinho) e chat (aviso no meio de tarefa longa). Sem notifier, conversa ou em grupo, não há.
 * O silêncio do usuário só vale se ele ligou o modo proativo (é onde configura os horários).
 */
export function resolveUserPushForRun(input: {
	origin: string;
	isGroupRun: boolean;
	hasConversation: boolean;
	routineNotify: RoutineNotifyMode;
	policyJson: unknown;
	accountTimezone?: string | null;
	send?: (text: string) => Promise<void>;
}): { mode: "routine" | "chat"; send: (text: string) => Promise<void>; quiet?: ProactiveSettings } | undefined {
	if (!input.send || !input.hasConversation || input.isGroupRun) return undefined;
	const mode = input.origin === "routine" ? (input.routineNotify === "important" ? "routine" : null) : input.origin === "chat" ? "chat" : null;
	if (!mode) return undefined;
	const settings = readProactiveSettings(input.policyJson, input.accountTimezone);
	return { mode, send: input.send, ...(settings.enabled ? { quiet: settings } : {}) };
}

type JevMode = "off" | "shadow" | "on";

function readMode(raw: string | undefined): JevMode | undefined {
	const value = raw?.trim().toLowerCase();
	return value === "off" || value === "shadow" || value === "on" ? value : undefined;
}

/**
 * Modo do Jev para "vale interromper o usuário?". `JEV_PROACTIVE_MODE` manda; sem ele
 * segue o item de intenção da conta (o Jev lendo o que o usuário quer). Desligado = só
 * valem silêncio e teto diário.
 */
export function proactiveJevMode(intentMode: JevMode | undefined, env: NodeJS.ProcessEnv = process.env): JevMode {
	return readMode(env.JEV_PROACTIVE_MODE) ?? intentMode ?? "off";
}

/** Jev julgando aprovações que o orquestrador decide pelos outros bots: `JEV_PENDING_MODE` manda; sem ele segue o item de intenção. Só "on" decide. */
export function pendingJevMode(intentMode: JevMode | undefined, env: NodeJS.ProcessEnv = process.env): JevMode {
	return readMode(env.JEV_PENDING_MODE) ?? intentMode ?? "off";
}

/** Verificador de ações do código: ligado por padrão; `JEV_ACTIONS_MODE` (off|shadow|on) manda. */
export function actionsJevMode(env: NodeJS.ProcessEnv = process.env): JevMode {
	return readMode(env.JEV_ACTIONS_MODE) ?? "on";
}

/** Modelo rápido do Verificador (OpenRouter); `JEV_ACTIONS_MODEL` troca. */
export const ACTIONS_JUDGE_MODEL_DEFAULT = "anthropic/claude-haiku-5.5";
export function actionsJudgeModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.JEV_ACTIONS_MODEL?.trim() || ACTIONS_JUDGE_MODEL_DEFAULT;
}

export const PROACTIVE_FAILURE_MESSAGE =
	"Não consegui executar o lembrete agendado agora. Vou tentar de novo mais tarde.";

/** Texto que o usuário vê quando um run proativo falha: nunca o erro técnico. */
export function proactiveFailureDisplay(origin: string, fallback: string): string {
	return origin === "proactive" ? PROACTIVE_FAILURE_MESSAGE : fallback;
}
