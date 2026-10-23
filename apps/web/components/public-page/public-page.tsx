"use client";

import { useCallback, useEffect, useState } from "react";
import type { PageSpec } from "@workspace/shared";
import { PageView } from "@/components/ai-elements/pages/page-view";
import { updatedAgo } from "@/components/ui/templates/template-4/chat-context-panel/library-sections";

export type SharedPage = {
	title: string;
	summary?: string;
	spec: PageSpec;
	updatedAt: string;
	botName: string | null;
};

export type PublicPageState = { kind: "loading" } | { kind: "ready"; page: SharedPage } | { kind: "gone" } | { kind: "error" };

/** Quanto esperar entre leituras: o painel mostra sempre a revisão mais recente. */
export const PUBLIC_PAGE_REFRESH_MS = 60_000;

/** Leitura pública do painel (sem sessão). 404 = link desativado, painel apagado ou token inválido. */
export async function fetchSharedPage(token: string, signal?: AbortSignal): Promise<PublicPageState> {
	try {
		const response = await fetch(`/v1/public/paineis/${encodeURIComponent(token)}`, { credentials: "omit", cache: "no-store", signal, referrerPolicy: "no-referrer" });
		if (response.status === 404) return { kind: "gone" };
		if (!response.ok) return { kind: "error" };
		const body = (await response.json()) as { page?: SharedPage };
		return body.page ? { kind: "ready", page: body.page } : { kind: "error" };
	} catch {
		return { kind: "error" };
	}
}

/** Conteúdo da página pública (apresentação pura, para teste). */
export function PublicPageContent({ state, now }: { state: PublicPageState; now?: Date }) {
	if (state.kind === "loading") {
		return <div aria-live="polite" className="h-40 animate-pulse rounded-xl bg-muted/40 motion-reduce:animate-none" data-testid="public-page-loading" />;
	}
	if (state.kind === "gone") {
		return (
			<div className="flex flex-col gap-2 rounded-xl border border-border/60 p-6 text-center" data-testid="public-page-gone">
				<h1 className="font-heading font-semibold text-lg">Este link não está mais disponível</h1>
				<p className="text-muted-foreground text-sm">O painel foi apagado ou quem o compartilhou desativou o link.</p>
			</div>
		);
	}
	if (state.kind === "error") {
		return (
			<p className="rounded-xl border border-border/60 p-6 text-center text-muted-foreground text-sm" role="alert">
				Não consegui carregar o painel agora. Tente de novo em instantes.
			</p>
		);
	}
	const { page } = state;
	const updated = updatedAgo(page.updatedAt, now);
	return (
		<article className="flex flex-col gap-4" data-testid="public-page">
			<header className="flex flex-col gap-1">
				<h1 className="font-heading font-semibold text-xl [overflow-wrap:anywhere]">{page.title}</h1>
				{page.summary ? <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">{page.summary}</p> : null}
			</header>
			<PageView spec={page.spec} />
			<footer className="border-border/60 border-t pt-3 text-muted-foreground text-xs">
				{[page.botName ? `Painel de ${page.botName}` : "Painel compartilhado", "somente leitura", updated].filter(Boolean).join(" · ")}
			</footer>
		</article>
	);
}

/** Página pública: lê o painel pelo token da URL e o atualiza sozinha (a cada minuto e ao voltar para a aba). */
export function PublicPage({ token }: { token: string }) {
	const [state, setState] = useState<PublicPageState>({ kind: "loading" });

	const load = useCallback(
		(signal?: AbortSignal) => {
			void fetchSharedPage(token, signal).then((next) => {
				if (signal?.aborted) return;
				// Falha de rede depois de carregar não apaga o que já está na tela.
				setState((current) => (next.kind === "error" && current.kind === "ready" ? current : next));
			});
		},
		[token],
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		const timer = window.setInterval(() => load(controller.signal), PUBLIC_PAGE_REFRESH_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") load(controller.signal);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			controller.abort();
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [load]);

	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:py-10">
			<PublicPageContent state={state} />
		</main>
	);
}
