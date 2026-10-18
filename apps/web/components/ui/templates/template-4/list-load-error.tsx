"use client";

import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";

/** Estado da lista de bots: erro nunca pode parecer "você não tem conversas". */
export type ListErrorMode = "none" | "full" | "banner";

export function listErrorMode(input: { loadError: boolean; loading: boolean; count: number }): ListErrorMode {
	if (!input.loadError || input.loading) return "none";
	return input.count === 0 ? "full" : "banner";
}

export const LIST_ERROR_TITLE = "Não deu para carregar suas conversas.";
export const LIST_ERROR_RETRY = "Tentar de novo";
export const LIST_ERROR_STALE = "Não deu para atualizar. Mostrando a última lista.";

/** `full`: no lugar da lista (nada carregado ainda). `banner`: faixa discreta sobre a última lista conhecida. */
export function ListLoadError({
	mode,
	onRetry,
	className = "",
}: {
	mode: Exclude<ListErrorMode, "none">;
	onRetry: () => void;
	className?: string;
}) {
	if (mode === "banner") {
		return (
			<div
				className={`mb-3 flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 text-sm text-muted-foreground ${className}`}
				role="status"
			>
				<AlertCircleIcon aria-hidden className="size-4 shrink-0" />
				<p className="min-w-0 flex-1 leading-snug">{LIST_ERROR_STALE}</p>
				<Button className="shrink-0" onClick={onRetry} size="sm" variant="ghost">
					{LIST_ERROR_RETRY}
				</Button>
			</div>
		);
	}
	return (
		<div className={`flex flex-col items-center py-16 text-center ${className}`} role="alert">
			<AlertCircleIcon aria-hidden className="size-8 text-muted-foreground" />
			<p className="mt-3 font-medium">{LIST_ERROR_TITLE}</p>
			<p className="mt-1 text-sm text-muted-foreground">Suas conversas continuam salvas. Confira a conexão.</p>
			<Button className="mt-5 min-h-11" onClick={onRetry}>
				<RefreshCwIcon /> {LIST_ERROR_RETRY}
			</Button>
		</div>
	);
}
