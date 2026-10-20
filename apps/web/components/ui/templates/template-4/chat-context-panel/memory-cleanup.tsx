"use client";

import { CheckIcon, ChevronDownIcon, SparklesIcon, XIcon } from "lucide-react";
import type { MemoryCleanupSuggestion, MemoryCleanupView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";

export type MemoryCleanupBlockProps = {
	cleanup: MemoryCleanupView | null;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	busy?: boolean;
	error?: string | null;
	/** Resultado de "Aplicar todas" (ex.: "3 aplicadas."). */
	notice?: string | null;
	/** A revisão terminou e não achou nada para limpar. */
	nothing?: boolean;
	confirmAll?: boolean;
	onReview?: () => void;
	onApply?: (id: string) => void;
	onDismiss?: (id: string) => void;
	onAskApplyAll?: () => void;
	onCancelApplyAll?: () => void;
	onApplyAll?: () => void;
};

const LAYER_LABEL = { user: "Sobre você", memory: "Deste bot" } as const;

function IconAction({ icon: Icon, label, onClick, disabled, spinning = false }: { icon: typeof CheckIcon; label: string; onClick?: () => void; disabled?: boolean; spinning?: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button aria-label={label} className="shrink-0" disabled={disabled} onClick={onClick} size="icon-sm" type="button" variant="ghost">
						<Icon aria-hidden className={spinning ? "animate-spin" : undefined} />
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function SuggestionCard({ suggestion, busy, onApply, onDismiss }: { suggestion: MemoryCleanupSuggestion; busy: boolean; onApply?: (id: string) => void; onDismiss?: (id: string) => void }) {
	const merge = suggestion.kind === "merge";
	return (
		<li className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card py-2.5 pr-1.5 pl-3" data-memory-cleanup-item={suggestion.id}>
			<div className="flex items-start justify-between gap-2">
				<p className="min-w-0 pt-1 font-medium text-xs">
					{merge ? `Juntar ${suggestion.entryIds.length} memórias` : "Apagar"}
					<span className="font-normal text-muted-foreground"> · {LAYER_LABEL[suggestion.target]}</span>
				</p>
				<div className="flex shrink-0 items-center">
					<IconAction disabled={busy} icon={CheckIcon} label="Aplicar" onClick={() => onApply?.(suggestion.id)} />
					<IconAction disabled={busy} icon={XIcon} label="Ignorar" onClick={() => onDismiss?.(suggestion.id)} />
				</div>
			</div>
			<ul className="m-0 flex list-none flex-col gap-1 p-0 pr-1.5">
				{suggestion.before.map((text, index) => (
					<li className="break-words text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap" key={`${suggestion.id}-${index}`}>
						{text}
					</li>
				))}
			</ul>
			{merge && suggestion.content ? (
				<p className="mr-1.5 break-words rounded-xl bg-muted/50 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">{suggestion.content}</p>
			) : null}
			{suggestion.reason ? <p className="pr-1.5 text-muted-foreground text-xs leading-relaxed">Motivo: {suggestion.reason}</p> : null}
		</li>
	);
}

/**
 * Limpeza da memória com aprovação: botão "Revisar memórias" e, havendo sugestões, o bloco recolhível
 * "Sugestões de limpeza". Apresentação pura; o estado mora em `useMemoryCleanup`.
 */
export function MemoryCleanupBlock({
	cleanup,
	open = false,
	onOpenChange,
	busy = false,
	error = null,
	notice = null,
	nothing = false,
	confirmAll = false,
	onReview,
	onApply,
	onDismiss,
	onAskApplyAll,
	onCancelApplyAll,
	onApplyAll,
}: MemoryCleanupBlockProps) {
	const suggestions = cleanup?.suggestions ?? [];
	const generating = cleanup?.status === "generating";
	const failure = !generating && cleanup?.status === "failed" ? cleanup.error : null;
	const shownError = error ?? failure;
	const status = generating ? "Revisando as memórias…" : nothing ? "Nada para limpar." : notice;

	return (
		<Collapsible className="min-w-0" onOpenChange={onOpenChange} open={open}>
			<section aria-label="Limpeza da memória" className="flex min-w-0 flex-col gap-2" data-memory-cleanup>
				<div className="flex items-center justify-between gap-2">
					{suggestions.length > 0 ? (
						<CollapsibleTrigger className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
							<span className="truncate font-medium text-sm">Sugestões de limpeza</span>
							<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">{suggestions.length}</span>
							<ChevronDownIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
						</CollapsibleTrigger>
					) : (
						<p className="min-w-0 flex-1 text-muted-foreground text-xs">{status}</p>
					)}
					{suggestions.length > 0 && status ? <span className="shrink-0 text-muted-foreground text-xs">{status}</span> : null}
					<IconAction disabled={busy || generating} icon={SparklesIcon} label="Revisar memórias" onClick={onReview} spinning={generating} />
				</div>
				{shownError ? (
					<p className="m-0 text-destructive text-xs leading-relaxed" role="alert">
						{shownError}
					</p>
				) : null}
				<CollapsibleContent className="flex flex-col gap-2">
					{confirmAll ? (
						<ConfirmAlert
							cancelLabel="Voltar"
							confirmLabel="Aplicar todas"
							description="Cada mudança fica em “O que mudou” e dá para desfazer."
							disabled={busy}
							onCancel={onCancelApplyAll ?? (() => undefined)}
							onConfirm={onApplyAll ?? (() => undefined)}
							title={`Aplicar as ${suggestions.length} sugestões?`}
						/>
					) : suggestions.length > 1 ? (
						<div className="flex justify-end">
							<Button disabled={busy} onClick={onAskApplyAll} size="sm" type="button" variant="outline">
								Aplicar todas
							</Button>
						</div>
					) : null}
					<ul className="m-0 flex list-none flex-col gap-2 p-0">
						{suggestions.map((suggestion) => (
							<SuggestionCard busy={busy} key={suggestion.id} onApply={onApply} onDismiss={onDismiss} suggestion={suggestion} />
						))}
					</ul>
				</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
