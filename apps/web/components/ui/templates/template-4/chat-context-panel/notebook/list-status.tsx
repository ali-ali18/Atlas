"use client";

import { Button } from "@workspace/ui/components/button";
import { useT } from "@/lib/i18n/provider";

/** Esqueleto enquanto a lista carrega. */
export function ListLoading() {
	return <div aria-live="polite" className="h-14 animate-pulse rounded-card bg-muted/40 motion-reduce:animate-none" data-testid="notebook-loading" />;
}

/** Falha ao carregar: frase simples e "Tentar de novo". */
export function ListLoadError({ onRetry }: { onRetry: () => void }) {
	const t = useT();
	return (
		<div className="flex flex-col items-start gap-2" role="alert">
			<p className="m-0 text-body text-destructive">{t("notebook.loadError")}</p>
			<Button onClick={onRetry} size="sm" type="button" variant="secondary">
				{t("notebook.retry")}
			</Button>
		</div>
	);
}

/** Estado vazio com convite (a configuração é por conversa; a tela só mostra). */
export function ListEmpty({ children }: { children: string }) {
	return <p className="m-0 px-2 py-4 text-center text-caption text-muted-foreground leading-relaxed">{children}</p>;
}

/** Erro de uma ação (fixar, apagar, desfazer…), colado à lista. */
export function ActionError({ message }: { message: string | null }) {
	return message ? (
		<p aria-live="polite" className="m-0 text-caption text-destructive" role="alert">
			{message}
		</p>
	) : null;
}
