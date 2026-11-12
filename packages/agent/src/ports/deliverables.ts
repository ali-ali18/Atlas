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

/** Linha da lista de painéis do bot do run. */
export type PanelSummary = { id: string; title: string; revision: number; updatedAt: string; groupName?: string | null; summary?: string };

/** Painel lido por id: o spec completo, para o modelo editar por `ops`. `shared` = há link público ligado. */
export type PanelRead = { id: string; title: string; revision: number; spec: PageSpec; sourceCount: number; shared: boolean };

/** `conflict` = outro update ganhou a corrida (a tool relê e tenta de novo uma vez). `not_found` vale também para painel de outro dono. */
export type PanelUpdateResult = { ok: true; id: string; title: string; revision: number } | { ok: false; error: "not_found" | "conflict" };

/**
 * Painéis do dono. Tudo escopado pelo `userId` do run (nunca de argumento do modelo): painel de outro dono, de outro bot
 * ou inexistente dá o mesmo `null` / `not_found`. O adaptador mostra o cartão (criado ou atualizado, MESMO `pageId`).
 */
export interface PageStore {
	save(userId: string, runId: string, spec: PageSpec): Promise<StoredPage>;
	/** Painéis do bot do run, mais recentes primeiro. */
	list(userId: string): Promise<PanelSummary[]>;
	read(userId: string, pageId: string): Promise<PanelRead | null>;
	/** Substitui o spec inteiro (já validado e com o patch aplicado), revisão + 1. `expectedRevision` = a que a tool leu. */
	update(userId: string, runId: string, pageId: string, spec: PageSpec, expectedRevision: number): Promise<PanelUpdateResult>;
	/** Liga (ou gira) o link público somente leitura. `null` = painel não encontrado. O endereço só existe nesta resposta. */
	share(userId: string, pageId: string): Promise<{ url: string } | null>;
	/** Desliga o link. `null` = painel não encontrado; `false` = não havia link ligado. */
	unshare(userId: string, pageId: string): Promise<boolean | null>;
}

export type StoredChart = { id: string };

export interface ChartStore {
	save(userId: string, runId: string, spec: ChartSpec): Promise<StoredChart>;
}

/** Tudo que a capacidade `deliverables` precisa de fora. */
export type DeliverablePorts = { files: DeliverableFiles; pages: PageStore; charts: ChartStore };
