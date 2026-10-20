"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryCleanupView } from "@workspace/shared";
import {
	applyAllMemoryCleanup,
	applyMemoryCleanupSuggestion,
	dismissMemoryCleanupSuggestion,
	getMemoryCleanup,
	startMemoryCleanup,
} from "@/lib/atlas-api";
import type { MemoryCleanupBlockProps } from "@/components/ui/templates/template-4/chat-context-panel/memory-cleanup";

const POLL_MS = 3000;

function messageOf(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Limpeza da memória com aprovação: "Revisar memórias" pede a revisão ao worker (que só sugere), consulta enquanto
 * ela roda e trata cada sugestão (aplicar/ignorar) ou todas. `onChanged` recarrega a lista de memórias depois de aplicar.
 */
export function useMemoryCleanup(botId: string, active: boolean, onChanged: () => Promise<void> | void) {
	const [cleanup, setCleanup] = useState<MemoryCleanupView | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirmAll, setConfirmAll] = useState(false);
	/** Revisão terminou sem nada a sugerir (vira "Nada para limpar"). */
	const [nothing, setNothing] = useState(false);
	const wasGenerating = useRef(false);
	const request = useRef(0);

	const settle = useCallback((next: MemoryCleanupView) => {
		setCleanup(next);
		if (wasGenerating.current && next.status !== "generating") {
			if (next.status === null && next.suggestions.length > 0) setOpen(true);
			setNothing(next.status === null && next.suggestions.length === 0);
		}
		wasGenerating.current = next.status === "generating";
	}, []);

	// Trocar de bot não mostra as sugestões do anterior.
	useEffect(() => {
		setCleanup(null);
		setOpen(false);
		setError(null);
		setNotice(null);
		setConfirmAll(false);
		setNothing(false);
		wasGenerating.current = false;
	}, [botId]);

	const load = useCallback(async () => {
		const id = ++request.current;
		try {
			const next = await getMemoryCleanup(botId);
			if (id === request.current) settle(next);
		} catch {
			// Sem sugestões na tela; a aba segue funcionando.
		}
	}, [botId, settle]);

	useEffect(() => {
		if (active) void load();
	}, [active, load]);

	// O worker grava em segundo plano: consulta até sair de "revisando".
	const generating = cleanup?.status === "generating";
	useEffect(() => {
		if (!active || !generating) return;
		const timer = setTimeout(() => void load(), POLL_MS);
		return () => clearTimeout(timer);
	}, [active, generating, cleanup, load]);

	const run = useCallback(
		async (task: () => Promise<void>, fallback: string) => {
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				await task();
			} catch (cause) {
				setError(messageOf(cause, fallback));
				// Sugestão velha (409) ou falha parcial: mostra o estado real.
				await load();
				await onChanged();
			} finally {
				setBusy(false);
			}
		},
		[load, onChanged],
	);

	const review = useCallback(
		() =>
			run(async () => {
				setNothing(false);
				await startMemoryCleanup(botId);
				wasGenerating.current = true;
				setCleanup((current) => ({ suggestions: current?.suggestions ?? [], status: "generating", error: null, requestedAt: new Date().toISOString() }));
			}, "Não foi possível iniciar a revisão."),
		[botId, run],
	);

	const apply = useCallback(
		(id: string) =>
			run(async () => {
				settle(await applyMemoryCleanupSuggestion(botId, id));
				await onChanged();
			}, "Não foi possível aplicar a sugestão."),
		[botId, onChanged, run, settle],
	);

	const dismiss = useCallback((id: string) => run(async () => settle(await dismissMemoryCleanupSuggestion(botId, id)), "Não foi possível ignorar a sugestão."), [botId, run, settle]);

	const applyAll = useCallback(
		() =>
			run(async () => {
				const result = await applyAllMemoryCleanup(botId);
				setConfirmAll(false);
				settle(result.cleanup);
				setNotice(result.skipped > 0 ? `${result.applied} aplicadas; ${result.skipped} não valiam mais.` : `${result.applied} aplicadas.`);
				await onChanged();
			}, "Não foi possível aplicar as sugestões."),
		[botId, onChanged, run, settle],
	);

	const props: MemoryCleanupBlockProps = {
		cleanup,
		open,
		onOpenChange: setOpen,
		busy,
		error,
		notice,
		nothing,
		confirmAll,
		onReview: () => void review(),
		onApply: (id) => void apply(id),
		onDismiss: (id) => void dismiss(id),
		onAskApplyAll: () => setConfirmAll(true),
		onCancelApplyAll: () => setConfirmAll(false),
		onApplyAll: () => void applyAll(),
	};
	return { props };
}
