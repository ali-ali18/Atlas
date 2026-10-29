"use client";

import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { useT } from "@/lib/i18n/provider";
import { defaultTranslator } from "@/lib/i18n/translator";

/** Estado da lista de bots: erro nunca pode parecer "você não tem conversas". */
export type ListErrorMode = "none" | "full" | "banner";

export function listErrorMode(input: { loadError: boolean; loading: boolean; count: number }): ListErrorMode {
	if (!input.loadError || input.loading) return "none";
	return input.count === 0 ? "full" : "banner";
}

/** Textos em pt-BR (padrão); a tela usa as chaves `sidebar.loadError.*` no idioma ativo. */
export const LIST_ERROR_TITLE = defaultTranslator.t("sidebar.loadError.title");
export const LIST_ERROR_RETRY = defaultTranslator.t("sidebar.loadError.retry");
export const LIST_ERROR_STALE = defaultTranslator.t("sidebar.loadError.stale");

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
	const t = useT();
	if (mode === "banner") {
		return (
			<div
				className={`mb-3 flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 text-sm text-muted-foreground ${className}`}
				role="status"
			>
				<AlertCircleIcon aria-hidden className="size-4 shrink-0" />
				<p className="min-w-0 flex-1 leading-snug">{t("sidebar.loadError.stale")}</p>
				<Button className="shrink-0" onClick={onRetry} size="sm" variant="ghost">
					{t("sidebar.loadError.retry")}
				</Button>
			</div>
		);
	}
	return (
		<div className={`flex flex-col items-center py-16 text-center ${className}`} role="alert">
			<AlertCircleIcon aria-hidden className="size-8 text-muted-foreground" />
			<p className="mt-3 font-medium">{t("sidebar.loadError.title")}</p>
			<p className="mt-1 text-sm text-muted-foreground">{t("sidebar.loadError.hint")}</p>
			<Button className="mt-5 min-h-11" onClick={onRetry}>
				<RefreshCwIcon /> {t("sidebar.loadError.retry")}
			</Button>
		</div>
	);
}
