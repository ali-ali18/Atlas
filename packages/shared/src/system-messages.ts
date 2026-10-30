import type { BotLanguage } from "./bot-language.js";

/**
 * Mensagens que o SISTEMA (não o modelo) mostra ao usuário quando o run para: limites, travas e retomada. Pequeno
 * dicionário por idioma, escolhido pelo idioma resolvido do run (`resolveReplyLanguage(...).language`).
 * Idioma novo: o compilador cobra a entrada aqui (`Record<BotLanguage, …>`). O texto em pt-BR é o de antes
 * (testes e telas que o citam seguem valendo). O rótulo "Resumir agora" é o botão da tela, que ainda é só pt-BR.
 */
export type SystemMessages = {
	/** Fechamento padrão quando o run parou por limite e o resumo do modelo não saiu. `reason` vem das mensagens abaixo. */
	stopFallback: (reason: string) => string;
	/** `duration`: "45s" ou "5 min". */
	wallLimit: (duration: string) => string;
	costCap: (usd: string) => string;
	tokenLimit: (tokens: number) => string;
	stepLimit: (steps: number) => string;
	stepLimitStalled: (steps: number) => string;
	contextLimit: (input: { tokens: string; percent: number; window: string; model?: string }) => string;
	noProgress: string;
	repeatedWithoutProgress: (tool: string) => string;
	readingWithoutFile: string;
	truncatedToolCall: string;
	autoContinueStatus: string;
	/** Falha de um lembrete/run proativo: nunca o erro técnico. */
	proactiveFailure: string;
	/** Imagem anexada que não carregou do armazenamento (depois de uma nova tentativa): o sistema avisa, não o modelo. */
	imageUnavailable: string;
	/** Erro de run traduzido para o usuário (ver `describeRunError`). */
	runErrors: Record<RunErrorKind, string>;
};

/** Tipos de erro de run que têm texto para o usuário. */
export type RunErrorKind =
	| "rate_limit"
	| "provider_down"
	| "auth"
	| "credits"
	| "context_too_long"
	| "content_filter"
	| "timeout"
	| "network"
	| "bad_request"
	| "unknown";

export const SYSTEM_MESSAGES: Record<BotLanguage, SystemMessages> = {
	"pt-BR": {
		stopFallback: (reason) => `Parei porque ${reason}. O que já foi feito ficou salvo nesta conversa. Responda "continuar" que eu retomo de onde parei.`,
		wallLimit: (duration) => `tempo máximo do run esgotado (${duration})`,
		costCap: (usd) => `custo máximo da execução atingido (US$ ${usd})`,
		tokenLimit: (tokens) => `limite de ${tokens} tokens do run esgotado`,
		stepLimit: (steps) => `limite de ${steps} passos esgotado`,
		stepLimitStalled: (steps) => `limite de ${steps} passos esgotado sem evidência para continuar`,
		contextLimit: ({ tokens, percent, window, model }) =>
			`Contexto estimado em ~${tokens} tokens (>${percent}% da janela de ${window}${model ? ` do modelo ${model}` : ""}). Resuma a conversa ("Resumir agora") ou use um modelo com janela maior e tente de novo.`,
		noProgress: "Parei porque o run não estava avançando (detectado automaticamente).",
		repeatedWithoutProgress: (tool) => `Travei repetindo ${tool} com o mesmo resultado, sem progresso.`,
		readingWithoutFile: "O assistente continuou lendo fontes sem gerar o arquivo pedido.",
		truncatedToolCall: "A resposta do modelo foi cortada pelo limite de saída várias vezes ao montar a chamada de ferramenta.",
		autoContinueStatus: "Retomando automaticamente…",
		proactiveFailure: "Não consegui executar o lembrete agendado agora. Vou tentar de novo mais tarde.",
		imageUnavailable: "Não consegui carregar a imagem que você enviou. Pode mandar de novo?",
		runErrors: {
			rate_limit: "O provedor do modelo está limitando pedidos agora. Tente em alguns minutos ou troque de modelo.",
			provider_down: "O provedor do modelo está instável ou fora do ar agora. Tente de novo em alguns minutos ou troque de modelo.",
			auth: "A chave do provedor do modelo foi recusada. Confira em Configurações › Provedores.",
			credits: "O saldo ou o limite de uso do provedor do modelo acabou. Recarregue ou confira o plano em Configurações › Provedores.",
			context_too_long: "A conversa ficou grande demais para este modelo. Comece uma nova conversa ou troque para um modelo com janela maior.",
			content_filter: "O provedor bloqueou esta resposta por política de conteúdo. Reformule o pedido ou troque de modelo.",
			timeout: "O modelo demorou demais para responder e foi interrompido. Tente de novo, peça o arquivo em partes menores ou troque de modelo.",
			network: "Não consegui falar com o provedor do modelo (falha de conexão). Tente de novo em instantes.",
			bad_request: "O provedor do modelo recusou o pedido. Tente de novo ou troque de modelo.",
			unknown: "Algo deu errado ao executar esta tarefa. Tente de novo em instantes; se continuar, troque de modelo.",
		},
	},
	"en-US": {
		stopFallback: (reason) => `I stopped because ${reason}. What was already done is saved in this conversation. Reply "continue" and I will pick up where I left off.`,
		wallLimit: (duration) => `the run's maximum time was reached (${duration})`,
		costCap: (usd) => `the run's maximum cost was reached ($${usd})`,
		tokenLimit: (tokens) => `the run's limit of ${tokens} tokens was reached`,
		stepLimit: (steps) => `the limit of ${steps} steps was reached`,
		stepLimitStalled: (steps) => `the limit of ${steps} steps was reached with no evidence to keep going`,
		contextLimit: ({ tokens, percent, window, model }) =>
			`Context estimated at ~${tokens} tokens (>${percent}% of the ${window}-token window${model ? ` of model ${model}` : ""}). Summarize the conversation ("Resumir agora") or use a model with a larger window and try again.`,
		noProgress: "I stopped because the run was not making progress (detected automatically).",
		repeatedWithoutProgress: (tool) => `I got stuck repeating ${tool} with the same result, without progress.`,
		readingWithoutFile: "The assistant kept reading sources without producing the requested file.",
		truncatedToolCall: "The model's reply was cut off by the output limit several times while building the tool call.",
		autoContinueStatus: "Resuming automatically…",
		proactiveFailure: "I could not run the scheduled reminder right now. I will try again later.",
		imageUnavailable: "I couldn't load the image you sent. Can you send it again?",
		runErrors: {
			rate_limit: "The model provider is limiting requests right now. Try again in a few minutes or switch models.",
			provider_down: "The model provider is unstable or down right now. Try again in a few minutes or switch models.",
			auth: "The model provider rejected the key. Check Configurações › Provedores.",
			credits: "The model provider's balance or usage limit ran out. Top up or check the plan in Configurações › Provedores.",
			context_too_long: "The conversation got too long for this model. Start a new conversation or switch to a model with a larger window.",
			content_filter: "The provider blocked this reply under its content policy. Rephrase the request or switch models.",
			timeout: "The model took too long to answer and was interrupted. Try again, ask for the file in smaller parts, or switch models.",
			network: "I could not reach the model provider (connection failure). Try again in a moment.",
			bad_request: "The model provider rejected the request. Try again or switch models.",
			unknown: "Something went wrong while running this task. Try again in a moment; if it keeps happening, switch models.",
		},
	},
	"es-ES": {
		stopFallback: (reason) => `Me detuve porque ${reason}. Lo que ya se hizo quedó guardado en esta conversación. Responde "continuar" y retomo desde donde lo dejé.`,
		wallLimit: (duration) => `se alcanzó el tiempo máximo de la ejecución (${duration})`,
		costCap: (usd) => `se alcanzó el coste máximo de la ejecución (US$ ${usd})`,
		tokenLimit: (tokens) => `se alcanzó el límite de ${tokens} tokens de la ejecución`,
		stepLimit: (steps) => `se alcanzó el límite de ${steps} pasos`,
		stepLimitStalled: (steps) => `se alcanzó el límite de ${steps} pasos sin evidencia para continuar`,
		contextLimit: ({ tokens, percent, window, model }) =>
			`Contexto estimado en ~${tokens} tokens (>${percent}% de la ventana de ${window}${model ? ` del modelo ${model}` : ""}). Resume la conversación ("Resumir agora") o usa un modelo con una ventana mayor e inténtalo de nuevo.`,
		noProgress: "Me detuve porque la ejecución no avanzaba (detectado automáticamente).",
		repeatedWithoutProgress: (tool) => `Me atasqué repitiendo ${tool} con el mismo resultado, sin avanzar.`,
		readingWithoutFile: "El asistente siguió leyendo fuentes sin generar el archivo pedido.",
		truncatedToolCall: "La respuesta del modelo se cortó varias veces por el límite de salida al montar la llamada a la herramienta.",
		autoContinueStatus: "Retomando automáticamente…",
		proactiveFailure: "No he podido ejecutar el recordatorio programado ahora. Lo intentaré de nuevo más tarde.",
		imageUnavailable: "No pude cargar la imagen que enviaste. ¿Puedes mandarla de nuevo?",
		runErrors: {
			rate_limit: "El proveedor del modelo está limitando las solicitudes ahora. Inténtalo en unos minutos o cambia de modelo.",
			provider_down: "El proveedor del modelo está inestable o caído ahora. Inténtalo de nuevo en unos minutos o cambia de modelo.",
			auth: "El proveedor del modelo rechazó la clave. Revisa Configurações › Provedores.",
			credits: "Se agotó el saldo o el límite de uso del proveedor del modelo. Recarga o revisa el plan en Configurações › Provedores.",
			context_too_long: "La conversación quedó demasiado larga para este modelo. Empieza una conversación nueva o cambia a un modelo con una ventana mayor.",
			content_filter: "El proveedor bloqueó esta respuesta por su política de contenido. Reformula la petición o cambia de modelo.",
			timeout: "El modelo tardó demasiado en responder y se interrumpió. Inténtalo de nuevo, pide el archivo en partes más pequeñas o cambia de modelo.",
			network: "No he podido contactar con el proveedor del modelo (fallo de conexión). Inténtalo de nuevo en un momento.",
			bad_request: "El proveedor del modelo rechazó la solicitud. Inténtalo de nuevo o cambia de modelo.",
			unknown: "Algo salió mal al ejecutar esta tarea. Inténtalo de nuevo en un momento; si sigue pasando, cambia de modelo.",
		},
	},
};

export function systemMessages(language: BotLanguage): SystemMessages {
	return SYSTEM_MESSAGES[language];
}

/** "45s" ou "5 min": o tempo do limite, igual em todos os idiomas. */
export function formatLimitDuration(limitMs: number): string {
	const seconds = Math.round(limitMs / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

/** Valor em dólar com duas casas no formato do idioma (pt-BR/es-ES: vírgula; en-US: ponto). */
export function formatUsd(language: BotLanguage, value: number): string {
	return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}

/**
 * `text` é uma mensagem de sistema (de qualquer idioma) com parâmetros preenchidos? Serve para o tradutor de erros
 * deixar passar o texto do próprio runtime, que já está pronto para o usuário, em vez de trocá-lo pelo genérico.
 */
export function isSystemMessage(text: string): boolean {
	const probe = "\u0000";
	for (const messages of Object.values(SYSTEM_MESSAGES)) {
		if (text === messages.noProgress || text === messages.readingWithoutFile || text === messages.truncatedToolCall) return true;
		const [head = "", tail = ""] = messages.repeatedWithoutProgress(probe).split(probe);
		if (text.length > head.length + tail.length && text.startsWith(head) && text.endsWith(tail)) return true;
	}
	return false;
}
