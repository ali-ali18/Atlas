"use client";

import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import { useTranslations } from "@/lib/i18n/provider";

/**
 * Painéis do mesmo grupo (o mesmo das rotinas) num bloco recolhível: chevron, nome e "N painéis".
 * Mesmo visual do RoutineGroupBlock, sem as ações de rotina (pausar, renomear e apagar ficam no bloco das rotinas).
 */
export function PageGroupBlock({ id, name, count, children }: { id: string; name: string; count: number; children: ReactNode }) {
	const { t, tn } = useTranslations();
	const [open, setOpen] = useState(true);
	const toggleKey = open ? "libraryPanel.collapseGroup" : "libraryPanel.expandGroup";
	return (
		<li className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border p-2" data-page-group={id}>
			<Collapsible onOpenChange={setOpen} open={open}>
				<CollapsibleTrigger
					aria-label={t(toggleKey, { name })}
					className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					<ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
					<span className="flex min-w-0 flex-col">
						<span className="truncate font-medium text-sm leading-tight" title={name}>
							{name}
						</span>
						<span className="truncate text-muted-foreground text-xs leading-tight">{count === 0 ? t("libraryPanel.pageCount.other", { count }) : tn("libraryPanel.pageCount", count)}</span>
					</span>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<ul className="m-0 flex list-none flex-col gap-2 p-0 pt-2">{children}</ul>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}
