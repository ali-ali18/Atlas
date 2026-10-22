"use client";

import { ChevronDownIcon, Loader2Icon, ShrinkIcon } from "lucide-react";

import { formatCompactionLine } from "@workspace/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";

export type CompactionCardProps = {
	/** Tokens estimados da conversa levada, antes e depois do resumo. */
	before: number;
	after: number;
	/** Texto do resumo (o que o assistente recebe como começo da conversa). */
	summary: string;
	/** Instruções de foco que a pessoa deu em `/compact <foco>`. */
	focus?: string;
	/** Abre já mostrando o resumo (por padrão recolhido). */
	defaultOpen?: boolean;
};

/**
 * Separador na conversa, no mesmo estilo do marcador de horário: "Conversa compactada · 48,2 mil → 6,1 mil
 * tokens (−87%)" entre duas linhas finas. Tocar abre o texto do resumo.
 */
export function CompactionCard({ before, after, summary, focus, defaultOpen = false }: CompactionCardProps) {
	return (
		<Collapsible className="w-full min-w-0" data-testid="compaction-card" defaultOpen={defaultOpen}>
			<Marker className="my-2 text-xs" variant="separator">
				<MarkerContent className="max-w-[calc(100%-3rem)]">
					<CollapsibleTrigger className="group/trigger inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
						<ShrinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
						<span className="min-w-0 truncate">
							<span className="max-sm:hidden">Conversa compactada · </span>
							<span className="sm:hidden">Compactada · </span>
							<span className="tabular-nums" data-testid="compaction-numbers">{formatCompactionLine(before, after)}</span>
						</span>
						<ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-aria-expanded/trigger:rotate-180" />
					</CollapsibleTrigger>
				</MarkerContent>
			</Marker>
			<CollapsibleContent>
				<div className="mt-1 flex max-h-72 min-w-0 flex-col gap-2 overflow-auto rounded-xl bg-muted/60 px-3 py-2 text-xs leading-5" data-testid="compaction-summary">
					{focus ? <p className="m-0 text-muted-foreground">Foco: {focus}</p> : null}
					<p className="m-0 min-w-0 whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">{summary}</p>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

export type CompactionNoticeState = { status: "working" } | { status: "notice"; text: string };

/** Estado passageiro do `/compact`: "Compactando a conversa…" enquanto roda e, se nada foi feito, o aviso curto. */
export function CompactionNotice({ state }: { state: CompactionNoticeState }) {
	return (
		<div
			aria-live="polite"
			className="my-1 flex w-full min-w-0 max-w-[min(68ch,100%)] items-center gap-2 px-3 py-1 text-muted-foreground text-xs"
			data-state={state.status}
			data-testid="compaction-notice"
			role="status"
		>
			{state.status === "working" ? <Loader2Icon aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" /> : <ShrinkIcon aria-hidden="true" className="size-3.5 shrink-0" />}
			<span className="min-w-0 break-words">{state.status === "working" ? "Compactando a conversa…" : state.text}</span>
		</div>
	);
}
