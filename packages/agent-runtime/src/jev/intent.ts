import { clipForJev, decideWithJev, jevModeFor, jevYes, type JevRuntime } from "./decide.js";

/**
 * Intenção do usuário em qualquer idioma. SÓ a última mensagem do usuário vai ao
 * Jev (nunca resultado de tool nem dado externo): injeção não consegue abrir tool.
 */
export type JevIntents = {
	profileChange: boolean;
	autonomy: boolean;
	subagentModel: boolean;
	cancel: boolean;
	confirm: boolean;
	/** O usuário pede um arquivo como entrega (pdf, planilha, documento...). */
	wantsFile: boolean;
	/** O pedido cobre vários itens parecidos (todas as seções, cada linha): pede checklist antes de entregar. */
	multiItem: boolean;
};

export const NO_INTENTS: JevIntents = {
	profileChange: false,
	autonomy: false,
	subagentModel: false,
	cancel: false,
	confirm: false,
	wantsFile: false,
	multiItem: false,
};

const yesNo = { true: "Yes", false: "No" };

export const INTENT_QUESTIONS = {
	profile_change: {
		instructions: "Does the user's message explicitly ask to change this assistant's own profile (its name, title, description, briefing or persona)? The message may be in any language.",
		criteria: yesNo,
	},
	autonomy: {
		instructions: "Does the user's message explicitly ask to change how much the assistant may do without asking permission (autonomy, confirmations, 'stop asking me', 'always ask me')? The message may be in any language.",
		criteria: yesNo,
	},
	subagent_model: {
		instructions: "Does the user's message explicitly ask to use a specific AI model for sub-agents or delegated tasks? The message may be in any language.",
		criteria: yesNo,
	},
	cancel: {
		instructions: "Is the user's message a short command to cancel, discard or abort a pending proposal? The message may be in any language.",
		criteria: yesNo,
	},
	wants_file: {
		instructions: "Does the user's message explicitly ask for a file to download or send as the deliverable (it names a file or format such as PDF, spreadsheet/Excel, Word document, presentation, CSV, or says 'file')? A report, summary, table, list or answer written in the chat is not a file, and neither is talking about files or asking about a format. The message may be in any language.",
		criteria: yesNo,
	},
	multi_item: {
		instructions: "Does the user's message ask to cover several similar things one by one (for example all the sections, weeks, pages, rows or records of something, or every item of a list), so that the same work repeats for 3 or more items? A single lookup or a single page is not.",
		criteria: yesNo,
	},
	confirm: {
		instructions: "Is the user's message a short command that accepts or confirms a pending proposal (for example 'yes', 'do it', 'confirm')? The message may be in any language.",
		criteria: yesNo,
	},
};

/**
 * Em `on` devolve os sinais do Jev. Em `shadow` só registra. Falha/`off`: tudo
 * falso (`NO_INTENTS`), ou seja, nenhuma tool/expectativa depende de intenção.
 */
export async function detectJevIntents(input: {
	rt: JevRuntime | undefined;
	latestUserMessage: string;
	signal?: AbortSignal;
}): Promise<JevIntents> {
	const mode = jevModeFor(input.rt, "intent");
	const message = input.latestUserMessage.trim();
	if (mode === "off" || !message) return NO_INTENTS;
	const result = await decideWithJev({
		rt: input.rt,
		feature: "intent",
		state: { latestUserMessage: clipForJev(message, 1_000) },
		questions: INTENT_QUESTIONS,
		signal: input.signal,
	});
	if (!result || mode !== "on") return NO_INTENTS;
	const a = result.answers;
	return {
		profileChange: jevYes(a.profile_change),
		autonomy: jevYes(a.autonomy),
		subagentModel: jevYes(a.subagent_model),
		cancel: jevYes(a.cancel),
		// Arquivo pedido liga o portão que cobra a entrega: só pedido explícito, limiar alto como o de confirmar.
		wantsFile: jevYes(a.wants_file, 0.9),
		multiItem: jevYes(a.multi_item),
		// Confirmar executa a ação pendente: limiar mais alto que os demais.
		confirm: jevYes(a.confirm, 0.9),
	};
}

export const REDIRECT_QUESTION = {
	redirect: {
		instructions: "Does the user's message explicitly change, replace or cancel the current task (not just a comment, a goodbye, thanks or a small addition)? The message may be in any language.",
		criteria: yesNo,
	},
};

/**
 * Mensagem enviada com o run ativo: muda a tarefa? `null` = Jev desligado,
 * indisponível ou falhou (o chamador cai no regex conservador); `false` inclui
 * "incerto" (abaixo do limiar), que vira join.
 */
export async function detectRedirectIntent(input: {
	rt: JevRuntime | undefined;
	message: string;
	signal?: AbortSignal;
}): Promise<boolean | null> {
	const message = input.message.trim();
	if (jevModeFor(input.rt, "intent") !== "on" || !message) return null;
	const result = await decideWithJev({
		rt: input.rt,
		feature: "intent",
		state: { latestUserMessage: clipForJev(message, 1_000) },
		questions: REDIRECT_QUESTION,
		signal: input.signal,
	});
	if (!result) return null;
	return jevYes(result.answers.redirect, 0.85);
}
