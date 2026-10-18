"use client";

import { ArrowRightIcon } from "lucide-react";
import { forwardRef } from "react";
import type { MemoryChange } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import {
	memoryChangeOriginLabel,
	memoryChangeScope,
	memoryChangeVerb,
	memoryRelativeDate,
	memoryUndoState,
} from "./memory-tab-helpers";

/** O texto da mudança: antes riscado e depois (alterou), só o novo (adicionou) ou só o apagado (apagou). */
function ChangeText({ change }: { change: MemoryChange }) {
	if (change.action === "replace") {
		return (
			<div className="flex min-w-0 flex-col gap-1 text-sm leading-relaxed">
				<p className="break-words text-muted-foreground line-through decoration-muted-foreground/60">{change.before}</p>
				<p className="flex min-w-0 items-start gap-1.5 break-words">
					<ArrowRightIcon aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
					<span className="min-w-0 break-words">{change.after}</span>
				</p>
			</div>
		);
	}
	if (change.action === "add") return <p className="break-words text-sm leading-relaxed">{change.after}</p>;
	return <p className="break-words text-muted-foreground text-sm leading-relaxed line-through decoration-muted-foreground/60">{change.before}</p>;
}

function ChangeRow({
	change,
	now,
	error,
	undoing,
	onUndo,
}: {
	change: MemoryChange;
	now: Date;
	error?: string;
	undoing: boolean;
	onUndo: (changeId: string) => void;
}) {
	const state = memoryUndoState(change);
	return (
		<li className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-card px-3 py-2.5" data-memory-change={change.id} data-undo-state={state}>
			<p className="text-muted-foreground text-xs">
				<span className="font-medium text-foreground">{memoryChangeVerb(change)}</span> · {memoryChangeScope(change)}
			</p>
			<ChangeText change={change} />
			<div className="flex min-w-0 items-center justify-between gap-2">
				<p className="min-w-0 truncate text-muted-foreground text-xs">
					{memoryChangeOriginLabel(change.source)} · {memoryRelativeDate(change.createdAt, now)}
				</p>
				{state === "available" ? (
					<Button className="shrink-0" disabled={undoing} onClick={() => onUndo(change.id)} size="sm" variant="outline">
						{undoing ? "Desfazendo..." : "Desfazer"}
					</Button>
				) : state === "undone" ? (
					<span className="shrink-0 text-muted-foreground text-xs">Desfeito</span>
				) : null}
			</div>
			{error ? (
				<p className="text-destructive text-xs leading-relaxed" role="alert">
					{error}
				</p>
			) : null}
		</li>
	);
}

/** Bloco "O que mudou": mudanças dos últimos 30 dias, com "Desfazer" nas que ainda dá. */
export const MemoryChanges = forwardRef<
	HTMLElement,
	{
		changes: MemoryChange[];
		now: Date;
		undoErrors: Record<string, string>;
		undoing: string | null;
		hasMore: boolean;
		loadingMore: boolean;
		onUndo: (changeId: string) => void;
		onLoadMore: () => void;
	}
>(function MemoryChanges({ changes, now, undoErrors, undoing, hasMore, loadingMore, onUndo, onLoadMore }, ref) {
	return (
		<section aria-labelledby="memory-changes-title" className="flex min-w-0 scroll-mt-2 flex-col gap-2" data-memory-section="changes" ref={ref}>
			<div className="flex flex-col">
				<h3 className="font-medium text-muted-foreground text-xs" id="memory-changes-title">
					O que mudou
				</h3>
				<p className="text-muted-foreground text-xs">Últimos 30 dias</p>
			</div>
			{changes.length === 0 ? (
				<p className="px-1 py-3 text-center text-muted-foreground text-xs leading-relaxed">Nada mudou na memória nos últimos 30 dias.</p>
			) : (
				<ul className="m-0 flex list-none flex-col gap-2 p-0">
					{changes.map((change) => (
						<ChangeRow change={change} error={undoErrors[change.id]} key={change.id} now={now} onUndo={onUndo} undoing={undoing === change.id} />
					))}
				</ul>
			)}
			{hasMore ? (
				<Button disabled={loadingMore} onClick={onLoadMore} size="sm" variant="ghost">
					{loadingMore ? "Carregando..." : "Ver mais"}
				</Button>
			) : null}
		</section>
	);
});
