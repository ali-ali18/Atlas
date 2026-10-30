// Liga o ciclo de vida de um run (começou, atividade, acabou) ao bus de atividade dos avatares.
// Puro em relação ao React: o hook `useAvatarActivity` só chama `sync` num efeito, e aqui
// ficam as regras (testáveis sem DOM):
// - os ids do run são capturados enquanto ele roda (em grupo o membro que responde pode
//   sumir no fim do run; quem participou ainda recebe o fim);
// - o fim vira `cancel` (neutro) se o usuário parou o run, `error` se houve erro, senão `ok`.
import type { AvatarRunContext } from "./avatar-activity";
import { beginBotRun, endBotRun, setBotActivity } from "./bot-activity";
import type { AgentActivity } from "./working-status";

export type AvatarRunBus = {
	begin(botId: string): void;
	activity(botId: string, activity: AgentActivity, ctx: AvatarRunContext): void;
	end(botId: string, outcome: "ok" | "error" | "cancel"): void;
};

const defaultBus: AvatarRunBus = {
	begin: (id) => beginBotRun(id),
	activity: (id, activity, ctx) => setBotActivity(id, activity, ctx),
	end: (id, outcome) => endBotRun(id, outcome),
};

export type AvatarRunInput = {
	botIds: readonly (string | undefined)[];
	activity: AgentActivity;
	running: boolean;
	status: string | null;
	paused: boolean;
	pendingApproval: boolean;
	error: string | null;
	/** Sobe a cada "Parar" do usuário. */
	cancelSeq: number;
	/** Texto de erro de run cancelado (outro aparelho parou o run). */
	cancelledMessage: string;
};

export function createAvatarRunTracker(bus: AvatarRunBus = defaultBus) {
	let wasRunning = false;
	let startCancelSeq = 0;
	const tracked = new Set<string>();

	return {
		sync(input: AvatarRunInput): void {
			const current = input.botIds.filter((id): id is string => Boolean(id));
			if (input.running) {
				if (!wasRunning) startCancelSeq = input.cancelSeq;
				const ctx = { status: input.status, paused: input.paused, pendingApproval: input.pendingApproval };
				for (const id of current) {
					if (!tracked.has(id)) {
						tracked.add(id);
						bus.begin(id);
					}
					bus.activity(id, input.activity, ctx);
				}
			} else if (wasRunning) {
				const cancelled = input.cancelSeq !== startCancelSeq || (input.error !== null && input.error === input.cancelledMessage);
				const outcome = cancelled ? "cancel" : input.error ? "error" : "ok";
				for (const id of tracked) bus.end(id, outcome);
				tracked.clear();
			}
			wasRunning = input.running;
		},
	};
}
