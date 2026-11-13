// Protocolo da capacidade `attachments` sobre a porta `Sandbox`: o `kind` da cópia para o computador e o formato do que
// volta em `data`. Quem executa é o tratador do worker (`apps/worker/src/v4-adapters/sandbox-attachments.ts`); mudou aqui,
// muda lá. O conteúdo do arquivo vai só nos bytes da ação, nunca no resultado nem no log.
import { z } from "zod";

export const ATTACHMENT_KINDS = {
	/** Grava os bytes de um anexo dentro da pasta `anexos` do computador. */
	copy: "attachments.copy",
} as const;

/** O nome já sanitizado pela capacidade; o tratador confere de novo (a fronteira não confia em quem chama). */
export const attachmentCopyParams = z.object({
	name: z.string().min(1).max(200),
	bytes: z.instanceof(Uint8Array),
});

export const attachmentCopyResult = z.object({ path: z.string().min(1).max(300) });
