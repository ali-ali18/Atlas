import { onBotMessageCreated, processBotMessages, type BotMessageDeps } from "@workspace/db";

const SWEEP_INTERVAL_MS = 3_000;

/**
 * Outbox de mensagens entre bots: entrega ao destino (adia se ocupado), devolve
 * a resposta ao remetente e o acorda. Um passo por vez (sem sobreposição); pedido
 * de passo durante outro roda de novo ao terminar. Nunca lança.
 */
export function startBotMessageSweeper(deps: BotMessageDeps): { kick: () => void; stop: () => void } {
	let running = false;
	let again = false;
	const sweep = async (): Promise<void> => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				const result = await processBotMessages(deps);
				if (result.delivered + result.replies + result.settled + result.needsUser > 0) {
					console.log(
						`[bot-messages] entregues=${result.delivered} respostas=${result.replies} encerradas=${result.settled} precisa-de-voce=${result.needsUser} adiadas=${result.busy}`,
					);
				}
			} while (again);
		} catch (error) {
			console.error("[bot-messages] sweep failed", error);
		} finally {
			running = false;
		}
	};
	const kick = (): void => {
		void sweep();
	};
	const timer = setInterval(kick, SWEEP_INTERVAL_MS);
	const unsubscribe = onBotMessageCreated(kick);
	return {
		kick,
		stop: () => {
			clearInterval(timer);
			unsubscribe();
		},
	};
}
