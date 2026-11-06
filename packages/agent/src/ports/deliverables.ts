// Portas das entregas ricas (F2.3): arquivo renderizado, painel e gráfico. O motor só valida e entrega os
// dados tipados; quem renderiza e guarda (docx, pdf, xlsx, pptx via `@workspace/files`, painel e gráfico no db)
// é o adaptador do worker. Todas escopadas pelo dono (`userId` vem do run, nunca do modelo).
import type { ChartSpec, CreateFileInput, PageSpec } from "@workspace/shared";
import type { StoredFile } from "./file-store.js";

export type DeliverableFile = StoredFile & { /** Versão do mesmo nome na conversa (1 = primeira). */ version?: number };

/** Qual parte do arquivo ler. Texto: `offset` (caractere). Planilha: `sheet` + `startRow` (1 = primeira linha). */
export type InspectPage = { offset?: number; sheet?: string; startRow?: number };

export type FileInspection = {
	name: string;
	bytes: number;
	/** Trecho do texto extraído (ou Markdown do documento). Ausente para planilha, que vem em `sheets`. */
	text?: string;
	/** Posição do trecho no texto inteiro (caracteres): `end < total` = ainda há o que ler a partir de `end`. */
	textRange?: { start: number; end: number; total: number };
	/** Linhas lidas por aba; `startRow`/`totalRows` dizem onde está o trecho (`startRow + rows.length - 1 < totalRows` = há mais). */
	sheets?: ReadonlyArray<{ name: string; rows: string[][]; truncated: boolean; startRow?: number; totalRows?: number }>;
	/** Há conteúdo além do que veio (sem faixa informada, a tool só avisa). */
	truncated: boolean;
};

/** Cria (renderiza + guarda) e inspeciona arquivos do dono. */
export interface DeliverableFiles {
	create(userId: string, runId: string, input: CreateFileInput): Promise<DeliverableFile>;
	/** `null` quando o arquivo não existe OU é de outro dono (o adaptador não distingue). Parte inválida (offset além do fim, aba inexistente) lança erro com o motivo. */
	inspect(userId: string, fileId: string, page?: InspectPage): Promise<FileInspection | null>;
}

export type StoredPage = { id: string; title: string; url?: string };

export interface PageStore {
	save(userId: string, runId: string, spec: PageSpec): Promise<StoredPage>;
}

export type StoredChart = { id: string };

export interface ChartStore {
	save(userId: string, runId: string, spec: ChartSpec): Promise<StoredChart>;
}

/** Tudo que a capacidade `deliverables` precisa de fora. */
export type DeliverablePorts = { files: DeliverableFiles; pages: PageStore; charts: ChartStore };
