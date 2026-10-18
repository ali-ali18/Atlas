/**
 * Cursor do agente na tela do sandbox: o que o usuário vê enquanto o agente
 * usa o navegador. Evento efêmero (só para a UI); nunca carrega texto digitado.
 */
export type AgentPointerAction = "move" | "click" | "type" | "scroll" | "navigate";

export type AgentPointerEvent = {
	type: "agent_pointer";
	action: AgentPointerAction;
	/** Posição na tela do sandbox (pixels reais); ausente quando não se sabe. */
	x?: number;
	y?: number;
	/** Tamanho da tela do sandbox em que x/y foram medidos (0 = desconhecido). */
	viewportW: number;
	viewportH: number;
	/** Frase curta em pt-BR do que o agente faz agora (sem segredos). */
	label: string;
	/** Epoch em ms de quando a ação aconteceu. */
	at: number;
};

/** Tamanho máximo do nome de elemento que entra no rótulo. */
export const AGENT_POINTER_NAME_MAX = 40;
