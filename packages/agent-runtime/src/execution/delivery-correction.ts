import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { RunUsage } from "@workspace/shared";
import { modelUsage } from "../telemetry/model-usage.js";

/**
 * Depois de entregar o arquivo, o modelo às vezes descobre um erro nele e só
 * avisa, ou oferece uma versão corrigida. Com orçamento sobrando, o certo é
 * regerar o arquivo, não oferecer. Sem lista de frases por idioma: uma chamada
 * pequena ao modelo barato (mesmo padrão da triagem de mensagem) responde
 * `{"fixFile": true|false}`. Nunca derruba o run: falha, timeout ou JSON
 * inválido = aceita a resposta como está.
 */

/** Acima disso o run está no fim: melhor entregar a verdade do que abrir outra rodada. */
export const REGENERATE_MAX_BUDGET_FRACTION = 0.9;
export const FILE_CORRECTION_TIMEOUT_MS = 8_000;
export const FILE_CORRECTION_MAX_OUTPUT_TOKENS = 60;
const REPLY_MAX_CHARS = 3_000;

export type FileCorrectionStreamChat = (params: CompleteChatWithToolsParams) => Promise<CompleteChatWithToolsResult>;

/** Só pergunta ao modelo se há arquivo no run, a checagem ainda não rodou e o orçamento permite outra rodada. */
export function shouldCheckFileCorrection(input: {
	hasFile: boolean;
	alreadyChecked: boolean;
	usedFraction: number;
}): boolean {
	return input.hasFile && !input.alreadyChecked && input.usedFraction < REGENERATE_MAX_BUDGET_FRACTION;
}

export const FILE_CORRECTION_SYSTEM =
	'Does this reply point out an error in a file the assistant already created, or offer to produce a corrected version? Answer JSON only: {"fixFile": true|false}';

/** Validação estrita: só `{"<key>": boolean}`; qualquer desvio = `null`. */
function parseBooleanKey(raw: string | null | undefined, key: string): boolean | null {
	if (!raw) return null;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const data: unknown = JSON.parse(raw.slice(start, end + 1));
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		const value = (data as Record<string, unknown>)[key];
		return typeof value === "boolean" ? value : null;
	} catch {
		return null;
	}
}

export function parseFileCorrection(raw: string | null | undefined): boolean | null {
	return parseBooleanKey(raw, "fixFile");
}

export type FileCorrectionVerdict = { fixFile: boolean; usage: RunUsage };

type ReplyQuestionInput = {
	streamChat: FileCorrectionStreamChat;
	model: string;
	apiKey: string;
	reply: string;
	signal?: AbortSignal;
	timeoutMs?: number;
};

/** Uma pergunta de sim/não sobre a resposta, ao modelo barato. `null` = sem veredito. */
async function askAboutReply(input: ReplyQuestionInput & { system: string; key: string }): Promise<{ value: boolean; usage: RunUsage } | null> {
	const timeoutMs = input.timeoutMs ?? FILE_CORRECTION_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const call = input.streamChat({
			messages: [
				{ role: "system" as const, content: input.system },
				{ role: "user" as const, content: `Reply:\n${input.reply.trim().slice(0, REPLY_MAX_CHARS)}` },
			],
			model: input.model,
			apiKey: input.apiKey,
			tools: [],
			toolChoice: "none",
			signal,
			timeoutMs,
			maxOutputTokens: FILE_CORRECTION_MAX_OUTPUT_TOKENS,
		});
		// Corrida com o prazo: um streamChat que ignore o signal não pode segurar o run.
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		call.catch(() => undefined);
		const result = await Promise.race([call, deadline]);
		if (result === "timeout") return null;
		const value = parseBooleanKey(result.message.content, input.key);
		return value === null ? null : { value, usage: modelUsage(result) };
	} catch {
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** `null` = sem veredito (a resposta é aceita como está). */
export async function askFileCorrection(input: ReplyQuestionInput): Promise<FileCorrectionVerdict | null> {
	const verdict = await askAboutReply({ ...input, system: FILE_CORRECTION_SYSTEM, key: "fixFile" });
	return verdict ? { fixFile: verdict.value, usage: verdict.usage } : null;
}

export const FILE_PROMISE_SYSTEM =
	'Does this reply promise or announce a file (document, spreadsheet, PDF, presentation...) that it says it will create, or that it presents as already created? Answer JSON only: {"promisesFile": true|false}';

export type FilePromiseVerdict = { promisesFile: boolean; usage: RunUsage };

/**
 * Caminho raro: o usuário pediu um arquivo, o modelo foi avisado uma vez e ainda
 * não criou nenhum. A resposta continua prometendo o arquivo? (qualquer idioma).
 * `null` = sem veredito.
 */
export async function askFilePromise(input: ReplyQuestionInput): Promise<FilePromiseVerdict | null> {
	const verdict = await askAboutReply({ ...input, system: FILE_PROMISE_SYSTEM, key: "promisesFile" });
	return verdict ? { promisesFile: verdict.value, usage: verdict.usage } : null;
}

/** Pedido ao modelo (neutro) quando a resposta admite erro no arquivo ou oferece refazê-lo. */
export const REGENERATE_FILE_NOTE =
	"Your reply points out a problem in the file you created, or offers a corrected version. Do not offer: fix it now. Call the file tool again with the same filename and the corrected content (it is saved as a new version), then reply once, briefly, saying what changed. If the problem cannot be fixed with what you know, say so plainly and keep that figure only if you list it in unconfirmed and mark it as unconfirmed in the text.";
