"use client";

import { CheckIcon, ChevronRightIcon, ClockIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import { type ApprovalMarker as ApprovalMarkerData, type ApprovalMarkerStatus } from "@/lib/approval-dock";

const ICON: Record<ApprovalMarkerStatus, typeof CheckIcon> = {
	pending: ShieldAlertIcon,
	approved: CheckIcon,
	rejected: XIcon,
	skipped: XIcon,
	expired: ClockIcon,
	resolved: CheckIcon,
};

/**
 * Linha neutra que representa um cartão de aprovação na conversa. O cartão de verdade mora no dock
 * (acima do campo de texto); aqui só fica o estado. Tocar abre o comando. Pendente não usa isto: o cartão inteiro fica na conversa.
 */
export function ApprovalMarker({ detail, marker }: { marker: ApprovalMarkerData; detail?: string }) {
	const Icon = ICON[marker.status];
	const row = (
		<>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{marker.label}</span>
		</>
	);
	const base = "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-full px-2 text-left text-xs text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-3 focus-visible:ring-ring/30";
	return (
		<Collapsible data-approval-marker={marker.status}>
			<CollapsibleTrigger className={cn(base, "group/trigger")}>
				{row}
				<ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<pre className="m-0 mt-1 max-h-48 min-w-0 overflow-auto rounded-xl bg-muted/60 px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]" data-approval-marker-detail>
					{detail || marker.short}
				</pre>
			</CollapsibleContent>
		</Collapsible>
	);
}
