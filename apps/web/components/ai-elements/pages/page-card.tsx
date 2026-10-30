"use client";

import { useEffect, useState } from "react";
import { Maximize2Icon } from "lucide-react";
import type { PageSource, PageSpec } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";

import { AtlasApiError, type AtlasPage, getPage } from "@/lib/atlas-api";
import { updatedAgo } from "@/components/ui/templates/template-4/chat-context-panel/library-sections";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

import { ShareMenu } from "@/components/ai-elements/share/share-menu";

import { PageDialog } from "./page-dialog";
import { PageShareDialog } from "./page-share-dialog";
import { reconcilePageSnapshot, sourceCountLabel, type PageViewState, type RemotePage } from "./page-format";
import { PageView } from "./page-view";

export type PageCardData = {
	pageId: string;
	revision: number;
	title: string;
	action: "created" | "updated";
	spec?: PageSpec;
	sourceCount: number;
};

export type LoadPage = (pageId: string) => Promise<RemotePage | "missing">;

/** Painel do servidor → o que o cartão compara/mostra; "Atualizado há X" vale a última atualização com dados novos (rotina), senão a edição. */
export function remotePageFromApi(page: Pick<AtlasPage, "spec" | "revision" | "sources" | "refreshedAt" | "updatedAt">): RemotePage {
	return { spec: page.spec, revision: page.revision, sources: page.sources as PageSource[], updatedAt: page.refreshedAt ?? page.updatedAt };
}

/** Leitura do servidor (revalida a revisão); 404 = painel apagado. Outros erros: fica o snapshot. */
const defaultLoadPage: LoadPage = async (pageId) => {
	try {
		return remotePageFromApi(await getPage(pageId));
	} catch (error) {
		if (error instanceof AtlasApiError && error.status === 404) return "missing";
		throw error;
	}
};

/** "Atualizado há 5 min" (ou "Atualizado agora", "Atualizado ontem"). */
export function updatedLabel(iso: string | null, now: Date = new Date(), translator: Translator = defaultTranslator): string | null {
	return updatedAgo(iso, now, translator);
}

/**
 * Cartão do painel no chat: desenha o painel inteiro inline (snapshot gravado na mensagem), revalida pelo
 * servidor e troca para a revisão mais nova se houver. Toque em "Abrir" (ou no rodapé) abre em tela cheia.
 */
export function PageCard({ card, loadPage = defaultLoadPage, now, botName }: { card: PageCardData; loadPage?: LoadPage; now?: Date; botName?: string | null }) {
	const [remote, setRemote] = useState<RemotePage | "missing" | null>(null);
	const [open, setOpen] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);

	// Nova revisão do cartão (evento ao vivo) → lê de novo; o snapshot do cartão já cobre o intervalo.
	useEffect(() => {
		let cancelled = false;
		loadPage(card.pageId)
			.then((result) => {
				if (!cancelled) setRemote(result);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [card.pageId, card.revision, loadPage]);

	const view: PageViewState | null = reconcilePageSnapshot(card, remote);
	const translator = useTranslations();
	const count = sourceCountLabel(view?.sourceCount ?? card.sourceCount, translator);
	const updated = view ? updatedLabel(view.updatedAt, now, translator) : null;

	return (
		<section aria-label={translator.t("chat.page.ariaLabel", { title: card.title })} className="my-1 w-full min-w-0 max-w-[min(68ch,100%)] overflow-hidden rounded-2xl bg-muted/60 text-card-foreground" data-testid="page-card">
			<div data-share-target>
			<header className="flex items-start gap-2 px-4 pt-3">
				<div className="min-w-0 flex-1">
					<h3 className="font-heading font-semibold text-sm [overflow-wrap:anywhere]">{card.title}</h3>
					{count ? <p className="text-muted-foreground text-xs">{count}</p> : null}
				</div>
				{view && !view.removed ? <ShareMenu botName={botName} onPublicLink={() => setShareOpen(true)} pdf targetSelector="[data-share-target]" title={card.title} /> : null}
				<Button aria-label={translator.t("chat.page.openFullscreen")} className="shrink-0" data-share-ignore onClick={() => setOpen(true)} size="icon-sm" variant="ghost">
					<Maximize2Icon />
				</Button>
			</header>
			{view?.spec.summary ? <p className="px-4 pt-1 text-sm [overflow-wrap:anywhere]">{view.spec.summary}</p> : null}
			<div className="px-4 py-3">
				{view ? <PageView spec={view.spec} /> : <div aria-live="polite" className="h-24 animate-pulse rounded-lg bg-muted/40 motion-reduce:animate-none" data-testid="page-loading" />}
			</div>
			</div>
			<footer>
				<button
					className={cn("flex w-full items-center gap-1 px-4 py-2 text-left text-muted-foreground text-xs outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/30")}
					onClick={() => setOpen(true)}
					type="button"
				>
					<span>{view?.removed ? translator.t("chat.page.deleted") : translator.t("chat.page.label")}</span>
					{updated ? <span>· {updated}</span> : null}
				</button>
			</footer>
			{view ? <PageDialog botName={botName} onOpenChange={setOpen} onPublicLink={() => setShareOpen(true)} open={open} sources={view.sources} spec={view.spec} summary={view.spec.summary} title={card.title} updatedLabel={updated} /> : null}
			{shareOpen ? <PageShareDialog onOpenChange={setShareOpen} open pageId={card.pageId} title={card.title} /> : null}
		</section>
	);
}
