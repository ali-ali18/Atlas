"use client";

import { Loader2Icon, ShrinkIcon } from "lucide-react";

import { formatCompactionLine } from "@workspace/shared";

export type CompactionCardProps = {
	/** Tokens estimados da conversa levada, antes e depois do resumo. */
	before: number;
	after: number;
	/** Texto do resumo. Fica salvo para o assistente; a conversa mostra só o marcador. */
	summary: string;
	/** Instruções de foco que a pessoa deu em `/compact <foco>`. */
	focus?: string;
};

/**
 * Marcador na conversa: "Conversa compactada · 48,2 mil → 6,1 mil tokens (−87%)", centralizado, sem linhas
 * laterais e sem abrir o resumo (o resumo é para o assistente, não para ler no meio do chat).
 */
export function CompactionCard({ before, after }: CompactionCardProps) {
	return (
		<div className="my-2 flex w-full min-w-0 justify-center text-muted-foreground text-xs" data-testid="compaction-card">
			<span className="inline-flex max-w-full items-center gap-1.5 px-1">
				<ShrinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">
					<span className="max-sm:hidden">Conversa compactada · </span>
					<span className="sm:hidden">Compactada · </span>
					<span className="tabular-nums" data-testid="compaction-numbers">{formatCompactionLine(before, after)}</span>
				</span>
			</span>
		</div>
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
