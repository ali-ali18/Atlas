"use client";

import { ChevronDownIcon, HistoryIcon } from "lucide-react";
import { useState } from "react";
import { draftRevisionLabel } from "@workspace/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { sanitizeAssistantText } from "@/lib/sanitize-message";

/**
 * Fala que o usuário já viu sendo escrita e que o run refez (`assistant_discard`). Não some: fica recolhida
 * como "rascunho revisado", com o motivo, e a versão nova vem logo abaixo.
 */
export function RevisedDraft({ text, reason }: { text: string; reason: string }) {
	const [open, setOpen] = useState(false);
	const clean = sanitizeAssistantText(text);
	if (!clean) return null;
	return (
		<Collapsible className="max-w-[min(68ch,100%)]" onOpenChange={setOpen} open={open}>
			<CollapsibleTrigger className="flex items-center gap-1.5 rounded-md py-0.5 text-muted-foreground text-xs hover:text-foreground">
				<HistoryIcon aria-hidden className="size-3.5 shrink-0" />
				<span>Rascunho revisado · {draftRevisionLabel(reason)}</span>
				<ChevronDownIcon aria-hidden className={open ? "size-3.5 rotate-180" : "size-3.5"} />
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-1 whitespace-pre-wrap border-border border-l-2 pl-3 text-muted-foreground text-sm [overflow-wrap:anywhere]">
				{clean}
			</CollapsibleContent>
		</Collapsible>
	);
}
