"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryChange, MemorySnapshot, MemoryTarget } from "@workspace/shared";
import {
	addMemoryItem,
	deleteMemoryItem,
	editMemoryItem,
	getBotMemory,
	listMemoryHistory,
	undoMemoryHistoryItem,
} from "@/lib/atlas-api";
import { useHubEvents } from "@/hooks/use-event-hub";

const HISTORY_PAGE = 20;

function messageOf(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Aba Memória: o que o bot lembra (perfil do usuário + memória deste bot), o histórico "O que mudou" e as
 * ações (adicionar, editar, apagar, desfazer). Recarrega ao abrir a aba, depois de cada ação e quando o hub
 * avisa que a memória mudou (conversa, reflexão diária, outra aba).
 */
export function useBotMemory(botId: string, active: boolean) {
	const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
	const [changes, setChanges] = useState<MemoryChange[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	/** Recusa do desfazer (ex.: "foi alterada depois"), por mudança, para aparecer na própria linha. */
	const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});
	const [undoing, setUndoing] = useState<string | null>(null);
	const request = useRef(0);

	const refresh = useCallback(async () => {
		const id = ++request.current;
		try {
			const [memory, history] = await Promise.all([getBotMemory(botId), listMemoryHistory(botId, { limit: HISTORY_PAGE })]);
			if (id !== request.current) return;
			setSnapshot(memory);
			setChanges(history.changes);
			setNextCursor(history.nextCursor);
			setError(null);
		} catch (cause) {
			if (id !== request.current) return;
			setError(messageOf(cause, "Não foi possível carregar a memória."));
		} finally {
			if (id === request.current) setLoading(false);
		}
	}, [botId]);

	// Trocar de bot não mostra a memória do anterior.
	useEffect(() => {
		setSnapshot(null);
		setChanges([]);
		setNextCursor(null);
		setUndoErrors({});
		setLoading(true);
		setError(null);
	}, [botId]);

	useEffect(() => {
		if (!active) return;
		void refresh();
	}, [active, refresh]);

	useHubEvents(["memory"], () => void refresh(), active);

	/** Roda a ação e recarrega; devolve a mensagem de erro (para o formulário mostrar inline) ou null. */
	const act = useCallback(
		async (run: () => Promise<unknown>, fallback: string): Promise<string | null> => {
			try {
				await run();
			} catch (cause) {
				return messageOf(cause, fallback);
			}
			await refresh();
			return null;
		},
		[refresh],
	);

	const add = useCallback((target: MemoryTarget, content: string) => act(() => addMemoryItem({ target, content, botId }), "Não foi possível adicionar."), [act, botId]);
	const edit = useCallback((entryId: string, content: string) => act(() => editMemoryItem(entryId, content), "Não foi possível salvar."), [act]);
	const remove = useCallback((entryId: string) => act(() => deleteMemoryItem(entryId), "Não foi possível apagar."), [act]);

	const undo = useCallback(
		async (changeId: string) => {
			setUndoing(changeId);
			setUndoErrors((current) => {
				const { [changeId]: _dropped, ...rest } = current;
				return rest;
			});
			try {
				await undoMemoryHistoryItem(changeId);
				await refresh();
			} catch (cause) {
				setUndoErrors((current) => ({ ...current, [changeId]: messageOf(cause, "Não foi possível desfazer.") }));
				// A recusa costuma ser "mudou depois": recarrega para a lista mostrar o estado real.
				await refresh();
			} finally {
				setUndoing(null);
			}
		},
		[refresh],
	);

	const loadMore = useCallback(async () => {
		if (!nextCursor || loadingMore) return;
		setLoadingMore(true);
		try {
			const page = await listMemoryHistory(botId, { cursor: nextCursor, limit: HISTORY_PAGE });
			setChanges((current) => [...current, ...page.changes.filter((item) => !current.some((known) => known.id === item.id))]);
			setNextCursor(page.nextCursor);
		} catch {
			// Mantém o que já está na tela; o botão "Ver mais" continua disponível.
		} finally {
			setLoadingMore(false);
		}
	}, [botId, nextCursor, loadingMore]);

	return { snapshot, changes, nextCursor, loading, error, undoErrors, undoing, loadingMore, refresh, add, edit, remove, undo, loadMore };
}
