import { onBotMessageCreated, processBotMessages, type BotMessageDeps, type BotMessageSweepResult } from "@workspace/db";
import { startAdaptiveSweeper, type AdaptiveSweeper } from "./adaptive-sweeper.js";

/** Com pedido aberto ou marcador pendente: volta logo, como antes. */
export const BOT_MESSAGE_SWEEP_BUSY_MS = 3_000;
/**
 * Sem nada aberto: só consulta de segurança. Mensagem nova acorda na hora (gancho no processo ou aviso do
 * Redis vindo da API) e o fim de um run no worker também.
 */
export const BOT_MESSAGE_SWEEP_IDLE_MS = 15_000;

/**
 * Outbox de mensagens entre bots: entrega ao destino (adia se ocupado), devolve
 * a resposta ao remetente e o acorda. Um passo por vez (sem sobreposição); pedido
 * de passo durante outro roda de novo ao terminar. Nunca lança.
 */
export function startBotMessageSweeper(
	deps: BotMessageDeps,
	options: {
		step?: (deps: BotMessageDeps) => Promise<BotMessageSweepResult>;
		triggers?: Array<(kick: () => void) => () => void>;
		busyMs?: number;
		idleMs?: number;
	} = {},
): AdaptiveSweeper {
	const step = options.step ?? processBotMessages;
	return startAdaptiveSweeper({
		name: "bot-messages",
		step: () => step(deps),
		onResult: (result) => {
			if (result.delivered + result.replies + result.settled + result.needsUser > 0) {
				console.log(
					`[bot-messages] entregues=${result.delivered} respostas=${result.replies} encerradas=${result.settled} precisa-de-voce=${result.needsUser} adiadas=${result.busy}`,
				);
			}
		},
		busyMs: options.busyMs ?? BOT_MESSAGE_SWEEP_BUSY_MS,
		idleMs: options.idleMs ?? BOT_MESSAGE_SWEEP_IDLE_MS,
		triggers: [onBotMessageCreated, ...(options.triggers ?? [])],
	});
}
