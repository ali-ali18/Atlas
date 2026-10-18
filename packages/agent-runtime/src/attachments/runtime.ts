import type { AttachmentRef, ExtractCache } from "./context.js";

/**
 * O que o worker entrega ao loop sobre os anexos de arquivo do usuário. O loop só
 * monta a mensagem e expõe as ferramentas; nada daqui executa o arquivo.
 */
export type AttachmentRuntime = {
	/** Há anexos nesta conversa: expõe `attachment_read` / `attachment_list`. */
	present: boolean;
	/** Texto dos anexos deste pedido (conteúdo truncado) para o fim da mensagem do usuário. */
	turnContext?: string;
	/** PDFs deste pedido que vão como documento nativo. */
	nativePdfs?: Array<{ id: string; filename: string }>;
	/** O modelo/provedor do run lê PDF como documento. */
	canReadNativePdf?: boolean;
	/** Anexos do dono nesta conversa (histórico + pedido atual). */
	list: () => Promise<AttachmentRef[]>;
	cache: ExtractCache;
	/** PDF como Data URL base64 (só para `file_ref`, na chamada ao modelo). */
	loadPdfDataUrl: (artifactId: string) => Promise<string | null>;
};
