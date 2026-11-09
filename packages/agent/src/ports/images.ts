// Porta de imagens (F9): gerar imagens novas com o modelo de imagem do dono. O adaptador do worker cobra o provedor,
// guarda cada imagem como arquivo do dono e mostra o cartão no chat. Toda chamada leva o `userId` do RUN (nunca do
// modelo). Falha = `throw` com o motivo real (a tool a devolve como `ok:false`).

export type GeneratedImageRef = { artifactId: string; mime: string; width: number; height: number };

export type GenerateImageInput = {
	prompt: string;
	/** 1 ou 2 por chamada (o limite do provedor). */
	count: number;
	/** `width:height`, ex.: `16:9`. Ausente = 1:1. */
	aspectRatio?: string;
	signal?: AbortSignal;
};

export type GenerateImageResult = {
	images: GeneratedImageRef[];
	/** Custo informado pelo provedor, em US$. Ausente quando o provedor não informou (não é zero). */
	costUsd?: number;
};

export interface Images {
	generate(userId: string, runId: string, input: GenerateImageInput): Promise<GenerateImageResult>;
}
