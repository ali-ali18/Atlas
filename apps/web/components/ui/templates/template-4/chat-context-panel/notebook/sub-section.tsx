"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";

/**
 * Sub-bloco recolhível dentro da seção Caderno. O corpo só existe enquanto aberto: o que está fechado não carrega
 * nada do servidor. `count` aparece como selo quando já se sabe (lista carregada).
 */
export function NotebookSubSection({
	id,
	title,
	count,
	defaultOpen = false,
	children,
}: {
	id: string;
	title: string;
	count?: ReactNode;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const titleId = `notebook-${id}-title`;
	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<section aria-labelledby={titleId} data-notebook-block={id}>
				<CollapsibleTrigger className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
					<ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
					<span className="font-medium text-body" id={titleId}>
						{title}
					</span>
					{count ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">{count}</span> : null}
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-1 pb-2">{open ? children : null}</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
