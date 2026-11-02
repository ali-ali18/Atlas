// Run ativo e lista de tarefas de cada bot, visíveis fora do chat (perfil e tela de Execuções). O controlador do
// chat alimenta este store (via `use-chat`); o chat continua montado por baixo quando o usuário abre o perfil, então
// o stream segue vivo enquanto ele navega. Módulo leve (sem React no núcleo): `useBotRun` só assina.
import * as React from "react";
import type { TaskItem } from "./chat-types";
import { taskListDockLine, taskListProgress, taskListSettledLabel } from "./chat-thread";

export type BotRunInfo = {
	/** Há um run em andamento (ou parado esperando a pessoa). */
	running: boolean;
	/** Os passos do run ativo (`null` sem lista). */
	tasks: readonly TaskItem[] | null;
	/** A última lista de tarefas da conversa, de uma execução já terminada. */
	last: readonly TaskItem[] | null;
	/** Para o run (o mesmo `stop` do chat); `null` fora do chat. */
	stop: (() => void) | null;
};

export const EMPTY_RUN: BotRunInfo = { running: false, tasks: null, last: null, stop: null };

const runs = new Map<string, { owner: string; info: BotRunInfo }>();
const listeners = new Set<() => void>();

const sameTasks = (a: readonly TaskItem[] | null, b: readonly TaskItem[] | null) => a === b || (a !== null && b !== null && a.length === b.length && a.every((item, index) => item.content === b[index]!.content && item.status === b[index]!.status));

/** `owner` identifica a instância do chat que escreve: duas telas do mesmo bot não apagam o run uma da outra. */
export function setBotRun(botId: string, info: BotRunInfo, owner = "default"): void {
	const current = runs.get(botId)?.info ?? EMPTY_RUN;
	if (runs.get(botId)?.owner === owner && current.running === info.running && current.stop === info.stop && sameTasks(current.tasks, info.tasks) && sameTasks(current.last, info.last)) return;
	runs.set(botId, { owner, info });
	for (const listener of listeners) listener();
}

/** Só quem escreveu por último (o dono atual) limpa: o cleanup de uma instância velha não apaga o run da nova. */
export function clearBotRun(botId: string, owner = "default"): void {
	if (runs.get(botId)?.owner !== owner) return;
	runs.delete(botId);
	for (const listener of listeners) listener();
}

/** Sair da conta ou trocar de servidor: nada do run de uma conta fica para a próxima. */
export function clearAllBotRuns(): void {
	if (runs.size === 0) return;
	runs.clear();
	for (const listener of listeners) listener();
}

export const getBotRun = (botId: string | undefined): BotRunInfo => (botId ? (runs.get(botId)?.info ?? EMPTY_RUN) : EMPTY_RUN);

export function subscribeBotRuns(listener: () => void): () => void {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

/** Só testes. */
export function resetBotRuns(): void {
	runs.clear();
	listeners.clear();
}

export function useBotRun(botId: string | undefined): BotRunInfo {
	return React.useSyncExternalStore(subscribeBotRuns, () => getBotRun(botId));
}

/** O estado do perfil: "1/5 · Montar a estimativa" durante um run, ou "Nenhuma em andamento". */
export function runStatusLine(info: BotRunInfo): string {
	if (info.running) return info.tasks && info.tasks.length > 0 ? taskListDockLine(info.tasks) : "Em andamento";
	return "Nenhuma em andamento";
}

/** Título do bloco da tela de Execuções: o run ativo ou a última execução ("Tarefas · 5/5 concluídas"). */
export function lastRunLabel(items: readonly TaskItem[]): string {
	return taskListSettledLabel(items);
}

export { taskListProgress };
