// Protocolo da capacidade `video` sobre a porta `Sandbox`: o `kind` da ação e o formato do que volta em `data`.
// A porta é opaca de propósito; ESTE arquivo é o contrato entre a capacidade e o tratador do worker
// (`apps/worker/src/v4-adapters/sandbox-video.ts`). Mudou aqui, muda lá.
//
// `video.transcript`: baixa a legenda do vídeo DENTRO da VM do dono (yt-dlp; no YouTube, fallback pela página), limpa o VTT
// e devolve UMA página do texto por caracteres. O tratador guarda o texto limpo por pouco tempo, então pedir a parte
// seguinte não baixa de novo. O dono vem do run (a VM é a da conversa), nunca dos parâmetros.
import { z } from "zod";

export const VIDEO_KINDS = { transcript: "video.transcript" } as const;
export type VideoKind = (typeof VIDEO_KINDS)[keyof typeof VIDEO_KINDS];

export const VIDEO_DEFAULT_LIMIT = 12_000;
export const VIDEO_MAX_LIMIT = 30_000;
export const VIDEO_MAX_URL_CHARS = 2048;

/** Código de idioma curto: pt, pt-BR, en (validação de formato, não decisão de comportamento). */
export const VIDEO_LANG_FORMAT = /^[A-Za-z][A-Za-z0-9_-]{0,11}$/;

export const videoParams = {
	transcript: z.object({
		url: z.string().min(1).max(VIDEO_MAX_URL_CHARS),
		lang: z.string().regex(VIDEO_LANG_FORMAT).optional(),
		offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		limit: z.number().int().min(1).max(VIDEO_MAX_LIMIT),
	}),
} as const;

export const videoResults = {
	transcript: z.object({
		language: z.string(),
		/** Primeiro e último caractere desta parte e o tamanho total do texto. */
		offset: z.number().int().min(0),
		end: z.number().int().min(0),
		total: z.number().int().min(0),
		text: z.string(),
		/** O arquivo de legenda era grande demais para ler inteiro: o fim do vídeo não está no texto. */
		truncated: z.boolean(),
	}),
} as const;
export type VideoTranscriptData = z.output<typeof videoResults.transcript>;
