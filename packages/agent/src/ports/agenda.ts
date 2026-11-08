// Porta `Agenda` (F4.2): a proatividade do agente (lembrete, vigia, intenção por evento) sobre o banco do dono.
// Toda chamada leva o `userId` do RUN (nunca do modelo) e o adaptador só mexe no que é desse dono. A criação é planejada
// pela função pura `planAgendaItem` (shared) ANTES de chegar aqui; o adaptador guarda também a permissão decidida na
// criação (autonomia e regras do run que criou), que o run de agenda usa depois sem dono para perguntar.
import type { AgendaEventFilter, AgendaKind, AgendaOutcome, AgendaPlan, AgendaStatus, ProactiveSettings } from "@workspace/shared";

/** O que o modelo e a UI veem de um item. Datas em ISO 8601 (UTC). */
export type AgendaItemView = {
	id: string;
	kind: AgendaKind;
	status: AgendaStatus;
	note: string;
	/** Próxima execução. Em `intent` é o fim da vigência (acorda por evento, não por relógio). */
	nextRunAt: string;
	everyMinutes: number | null;
	untilAt: string | null;
	runCount: number;
	maxRuns: number | null;
	eventFilter: AgendaEventFilter | null;
	/** Por que encerrou ou pausou sozinho (`ignored_notices`, `max_runs`, `expired`, `no_result`, `done`, `owner`…). */
	endReason: string | null;
};

export type AgendaCreateResult = { ok: true; item: AgendaItemView; duplicate: boolean } | { ok: false; error: string };

export type AgendaAction = "pause" | "resume" | "cancel";

/** O que o run de agenda declara ao terminar. */
export type AgendaRunResult = {
	outcome: AgendaOutcome;
	/** O que o dono recebe (obrigatório em `update`; proibido em `no_change`). */
	message?: string;
	/** O que lembrar na próxima execução (último preço, último id visto…). Não vai ao dono. */
	memo?: string;
	/** O que ficou esperando o dono (aprovação, dado). Vai junto com a mensagem; a agenda não pergunta a cada execução. */
	pending?: string[];
};

export interface Agenda {
	/** Fuso do dono (a agenda do v4 não usa horário de silêncio). */
	settings(userId: string): Promise<ProactiveSettings>;
	/** `untrustedRead`: o run criador já tinha lido conteúdo não confiável; a nota fica marcada e entra como dado no wake. */
	/**
	 * `exactIdentity`: o item tem identidade própria fora da nota (ex.: o vigia de UMA compra). Pula o dedupe por similaridade
	 * de texto, que trataria a nota de dois vigias parecidos como o mesmo item; o limite de itens ativos continua valendo.
	 */
	create(userId: string, plan: AgendaPlan, context: { sourceRunId: string; untrustedRead?: boolean; exactIdentity?: boolean }): Promise<AgendaCreateResult>;
	list(userId: string, options?: { includeEnded?: boolean }): Promise<AgendaItemView[]>;
	/** `null` = não existe, não é do dono ou a ação não cabe no estado dele (a tool responde igual nos três casos). */
	change(userId: string, id: string, action: AgendaAction): Promise<AgendaItemView | null>;
	/** Resultado do run de agenda corrente (`runId`). Erro real quando o run não é de agenda ou já fechou. */
	reportResult(userId: string, runId: string, result: AgendaRunResult, context?: { untrustedRead?: boolean }): Promise<{ ok: true } | { ok: false; error: string }>;
}
