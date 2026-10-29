"use client";

import { ShrinkIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";
import { Spinner } from "@workspace/ui/components/spinner";

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
		<Marker className="my-2 justify-center text-xs" data-testid="compaction-card">
			<MarkerIcon>
				<ShrinkIcon />
			</MarkerIcon>
			<MarkerContent className="flex-none truncate">
				<span className="max-sm:hidden">Conversa compactada · </span>
				<span className="sm:hidden">Compactada · </span>
				<span className="tabular-nums" data-testid="compaction-numbers">{formatCompactionLine(before, after)}</span>
			</MarkerContent>
		</Marker>
	);
}

export type CompactionNoticeState = { status: "working" } | { status: "notice"; text: string };

/** Estado passageiro do `/compact`: "Compactando a conversa…" enquanto roda e, se nada foi feito, o aviso curto. */
export function CompactionNotice({ state }: { state: CompactionNoticeState }) {
	return (
		<Marker aria-live="polite" className="my-1 text-xs" data-state={state.status} data-testid="compaction-notice" role="status">
			<MarkerIcon>{state.status === "working" ? <Spinner /> : <ShrinkIcon />}</MarkerIcon>
			<MarkerContent>{state.status === "working" ? "Compactando a conversa…" : state.text}</MarkerContent>
		</Marker>
	);
}
