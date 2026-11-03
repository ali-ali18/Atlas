import { AgentRunCancelledError } from "../errors.js";
import type { V3Run } from "./state.js";

/**
 * Steering (desenho 2.8): mensagem do usuário durante o run entra como `user` normal no próximo limite. Entre as tools
 * de um lote, as restantes são puladas com motivo. Sem triagem por LLM. `cancel` para o run; `queue` fica para depois.
 * Devolve se há mensagem nova esperando entrar na conversa.
 */
export async function pollSteer(run: V3Run): Promise<boolean> {
	if (run.params.consumeSteerInputs) {
		for (const input of await run.params.consumeSteerInputs()) {
			if (run.consumedInputIds.has(input.id)) continue;
			if (input.mode === "cancel") throw new AgentRunCancelledError("Cancel solicitado via input");
			if (input.mode === "queue") continue;
			run.consumedInputIds.add(input.id);
			run.pendingSteer.push({ id: input.id, content: input.content, mode: input.mode ?? "join" });
			await run.emit({ type: "input_consumed", inputId: input.id, mode: input.mode ?? "join", content: input.content });
		}
	}
	return run.pendingSteer.length > 0;
}

/** Depois dos resultados do lote (pares chamada/resultado íntegros), as mensagens do usuário entram na conversa. */
export function flushSteer(run: V3Run): boolean {
	if (run.pendingSteer.length === 0) return false;
	for (const input of run.pendingSteer.splice(0)) run.conversation.push({ role: "user", content: input.content });
	return true;
}
