"use client";

import type { PageSource, PageSpec } from "@workspace/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";

import { PageView } from "./page-view";

/** Segurança: só http(s) vira link (o servidor já valida; aqui é a segunda trava antes do `href`). */
export function safeSourceHref(url: string | undefined): string | undefined {
	return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** Página em tela cheia (celular) ou folha larga (desktop), com as fontes ao final. */
export function PageDialog({
	open,
	onOpenChange,
	title,
	summary,
	spec,
	sources,
	updatedLabel,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	summary?: string;
	spec: PageSpec;
	sources: PageSource[] | null;
	updatedLabel?: string | null;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:content-start max-sm:rounded-none sm:max-h-[90dvh] sm:max-w-3xl content-start overflow-y-auto overscroll-contain"
				data-testid="page-dialog"
			>
				<DialogHeader className="pr-10">
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{[summary, updatedLabel].filter(Boolean).join(" · ")}</DialogDescription>
				</DialogHeader>
				<PageView spec={spec} />
				{sources && sources.length > 0 ? (
					<section aria-label="Fontes" className="border-border/60 border-t pt-3">
						<h4 className="mb-1.5 font-medium text-muted-foreground text-xs">Fontes</h4>
						<ul className="flex flex-col gap-1 text-xs">
							{sources.map((source, index) => {
								const href = safeSourceHref(source.url);
								return (
									<li className="min-w-0 truncate" key={`${source.title}-${index}`}>
										{href ? (
											<a className="underline underline-offset-2" href={href} rel="noopener noreferrer" target="_blank">
												{source.title}
											</a>
										) : (
											source.title
										)}
									</li>
								);
							})}
						</ul>
					</section>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
