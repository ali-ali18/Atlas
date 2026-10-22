"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import {
	LIBRARY_SECTION_DEFAULT_OPEN,
	type LibrarySectionId,
	readLibrarySectionOpen,
	writeLibrarySectionOpen,
} from "./library-sections";

/**
 * Aberto/fechado de uma seção, lembrado neste navegador. O primeiro desenho (servidor e hidratação) usa o padrão;
 * o valor guardado entra logo depois, para a marcação não divergir entre servidor e cliente.
 */
export function useLibrarySectionOpen(id: LibrarySectionId): [boolean, (open: boolean) => void] {
	const [open, setOpenState] = useState(LIBRARY_SECTION_DEFAULT_OPEN[id]);
	useEffect(() => {
		setOpenState(readLibrarySectionOpen(id));
	}, [id]);
	const setOpen = useCallback(
		(next: boolean) => {
			setOpenState(next);
			writeLibrarySectionOpen(id, next);
		},
		[id],
	);
	return [open, setOpen];
}

/**
 * Seção recolhível da Biblioteca: o título inteiro é o botão (aria-expanded, Enter/Espaço), a ação extra
 * (ex.: "+") fica ao lado, fora do botão. O conteúdo só existe enquanto aberta.
 */
export function LibrarySection({
	id,
	title,
	count,
	action,
	children,
}: {
	id: LibrarySectionId;
	title: string;
	/** Selo com a contagem; omitido quando ainda não se sabe. */
	count?: number;
	action?: ReactNode;
	children: ReactNode;
}) {
	const [open, setOpen] = useLibrarySectionOpen(id);
	const titleId = `library-section-${id}-title`;
	return (
		<Collapsible className="min-w-0" onOpenChange={setOpen} open={open}>
			<section aria-labelledby={titleId} data-library-section={id}>
				<div className="flex min-h-9 items-center gap-1">
					<CollapsibleTrigger className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
						<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
						<span className="font-medium text-sm" id={titleId}>
							{title}
						</span>
						{count !== undefined && count > 0 ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">{count}</span> : null}
					</CollapsibleTrigger>
					{action}
				</div>
				<CollapsibleContent className="pt-1.5 pb-2">{children}</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
