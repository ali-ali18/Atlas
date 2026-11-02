// Avatar do chat: junta a atividade do bot (chat-live), o governador do shared (permanência mínima, linger da
// ferramenta, reação de erro e de fim) e o mapa de estados do app. Puro: o relógio (`now`, ms) é de quem chama,
// que agenda o próximo `sync` com `nextMs`.
import { IDLE_DESIRED, avatarStateForActivity, createAvatarGovernor, type AgentActivity } from "@workspace/shared";
import { activityLabel, mobileAvatarState, stateLabel, type MobileAvatarState } from "./avatar-activity";

export type AvatarLiveInput = {
	activity: AgentActivity;
	/** Há um run em andamento (ou parado esperando a pessoa). */
	running: boolean;
	/** O run parou esperando a pessoa (aprovação, login). */
	paused: boolean;
	/** Contadores de `LiveState`: subir = ferramenta/run falhou, run terminou bem. */
	failures: number;
	finishes: number;
};

export type AvatarLiveOutput = {
	state: MobileAvatarState;
	/** O que o bot está fazendo, em pt-BR; `null` em repouso. */
	label: string | null;
	/** ms até o estado poder mudar só pelo tempo; `null` = nada agendado. */
	nextMs: number | null;
};

export function createAvatarLive() {
	const governor = createAvatarGovernor();
	let seen: { failures: number; finishes: number } | null = null;
	let wasRunning = false;
	let pushedKey = "";
	/** Último texto de cada estado (o governador pode manter "lendo" na tela depois que a atividade já virou "pensando"). */
	const labels: Partial<Record<MobileAvatarState, string>> = {};

	return {
		sync(input: AvatarLiveInput, now: number): AvatarLiveOutput {
			// Primeira leitura é a linha de base: contadores de um run antigo não disparam reação.
			if (!seen) seen = { failures: input.failures, finishes: input.finishes };
			if (input.running && !wasRunning) {
				governor.begin();
				pushedKey = "";
			}
			wasRunning = input.running;
			if (input.failures > seen.failures) governor.event("failed", now);
			if (input.finishes > seen.finishes) governor.event("finished", now);
			seen = { failures: input.failures, finishes: input.finishes };

			// Sem anel de progresso no app: só passo e estado (o passo vira texto).
			const desired = input.running ? { ...avatarStateForActivity(input.activity, { paused: input.paused }), progress: null } : IDLE_DESIRED;
			const key = `${desired.state}|${desired.step}`;
			if (key !== pushedKey) {
				governor.push(desired, now);
				pushedKey = key;
			}
			const desiredState = mobileAvatarState(desired.state);
			// Esperar a pessoa não é uma ferramenta: o texto dele é o do estado ("Esperando você").
			if (input.running && desiredState !== "waiting") labels[desiredState] = activityLabel(input.activity);

			const state = mobileAvatarState(governor.signal(now).state);
			return { state, label: labels[state] ?? stateLabel(state), nextMs: governor.nextChangeMs(now) };
		},
	};
}
