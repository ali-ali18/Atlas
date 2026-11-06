// Portas das entregas ricas (F2.3): arquivo renderizado, painel e gráfico. O motor só valida e entrega os
// dados tipados; quem renderiza e guarda (docx, pdf, xlsx, pptx via `@workspace/files`, painel e gráfico no db)
// é o adaptador do worker. Todas escopadas pelo dono (`userId` vem do run, nunca do modelo).
import type { ChartSpec, CreateFileInput, PageSpec } from "@workspace/shared";
import type { StoredFile } from "./file-store.js";

export type DeliverableFile = StoredFile & { /** Versão do mesmo nome na conversa (1 = primeira). */ version?: number };

export type FileInspection = {
	name: string;
	bytes: number;
	/** Texto extraído (ou Markdown do documento). Ausente para planilha, que vem em `sheets`. */
	text?: string;
	sheets?: ReadonlyArray<{ name: string; rows: string[][]; truncated: boolean }>;
	truncated: boolean;
};

/** Cria (renderiza + guarda) e inspeciona arquivos do dono. */
export interface DeliverableFiles {
	create(userId: string, runId: string, input: CreateFileInput): Promise<DeliverableFile>;
	/** `null` quando o arquivo não existe OU é de outro dono (o adaptador não distingue). */
	inspect(userId: string, fileId: string): Promise<FileInspection | null>;
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
