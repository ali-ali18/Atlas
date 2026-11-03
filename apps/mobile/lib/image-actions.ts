// Frases do visualizador de imagens para o resultado de Encaminhar, Compartilhar e Salvar (pt-BR simples, sem texto
// técnico). Puro: a parte nativa (compartilhar, galeria) está em `share-file.ts` e `save-image.ts`.
import { ChatApiError } from "./chat-api";
import { FileTooLargeError } from "./file-api";
import { TimeoutError } from "./with-timeout";

export type SaveOutcome = "saved" | "denied" | "unavailable";

export const IMAGE_NOTICE = {
	saved: "Imagem salva",
	saving: "Salvando…",
	denied: "Sem permissão para salvar na galeria. Libere nos ajustes do aparelho.",
	saveUnavailable: "Não dá para salvar aqui. Use Compartilhar.",
	shareUnavailable: "Compartilhar não está disponível neste aparelho.",
	prepareFailed: "Não consegui preparar a imagem.",
	saveFailed: "Não consegui salvar a imagem.",
	gone: "Esta imagem não existe mais.",
	expired: "Sua sessão expirou. Entre de novo.",
	tooLarge: "Imagem grande demais para enviar.",
	slow: "A imagem demorou para baixar. Tente de novo.",
	offline: "Sem conexão com o seu servidor. Tente de novo.",
} as const;

/** Frase para o erro de baixar a imagem (servidor, tamanho, rede). */
export function imageDownloadErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return IMAGE_NOTICE.expired;
		if (error.status === 404) return IMAGE_NOTICE.gone;
		return IMAGE_NOTICE.prepareFailed;
	}
	if (error instanceof FileTooLargeError) return IMAGE_NOTICE.tooLarge;
	if (error instanceof TimeoutError) return IMAGE_NOTICE.slow;
	// Falha de rede no RN chega como TypeError: é "sem conexão", não erro do servidor.
	return IMAGE_NOTICE.offline;
}

/** Aviso curto do resultado de Salvar. */
export function saveOutcomeText(outcome: SaveOutcome): string {
	if (outcome === "saved") return IMAGE_NOTICE.saved;
	if (outcome === "denied") return IMAGE_NOTICE.denied;
	return IMAGE_NOTICE.saveUnavailable;
}
