"use client";

import { ShrinkIcon, SparklesIcon } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";

import type { ComposerTrigger } from "@workspace/shared";
import { cn } from "@workspace/ui/lib/utils";

import { AppLogo } from "@/components/ai-elements/connectors/app-logo";
import { AgentAvatar } from "../agent-avatar";

/** Membro, outro bot ou skill oferecido no autocompletar (o suficiente para desenhar a linha). */
export type MentionCandidate = {
	id: string;
	name: string;
	color?: string;
	shape?: string;
	description?: string | null;
	isPrimary?: boolean;
	/** `app` = conector do usuário (o `@` 1:1 mostra bots e apps em seções). */
	kind?: "bot" | "app" | "command";
	logo?: string | null;
	connected?: boolean;
};

const LABELS: Record<ComposerTrigger, { aria: string; empty: string }> = {
	"@": { aria: "Mencionar membro do grupo", empty: "Nenhum outro bot" },
	"/": { aria: "Escolher skill", empty: "Nenhuma skill" },
};

/** Título da seção ("Bots"/"Apps") só no 1º item de cada tipo, e só quando há apps na lista. */
function sectionTitle(candidates: readonly MentionCandidate[], index: number): string | null {
	if (!candidates.some((candidate) => candidate.kind === "app")) return null;
	const kind = candidates[index]!.kind === "app" ? "app" : "bot";
	const previous = index > 0 ? (candidates[index - 1]!.kind === "app" ? "app" : "bot") : null;
	if (previous === kind) return null;
	return kind === "app" ? "Apps" : "Bots";
}

/**
 * Lista acima do campo, aberta ao digitar `@` (membros do grupo ou outros bots) ou `/` (skills).
 * Rola a partir de 6 linhas e nunca passa da largura do campo (celular).
 */
export function MentionPopup({
	candidates,
	activeIndex,
	onHover,
	onPick,
	trigger = "@",
	ariaLabel,
	emptyLabel,
}: {
	candidates: readonly MentionCandidate[];
	activeIndex: number;
	onHover?: (index: number) => void;
	onPick: (candidate: MentionCandidate) => void;
	trigger?: ComposerTrigger;
	ariaLabel?: string;
	emptyLabel?: string;
}) {
	const activeRef = useRef<HTMLButtonElement | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: segue o destaque do teclado dentro da lista rolável.
	useEffect(() => {
		activeRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex]);
	const labels = LABELS[trigger];
	return (
		<div
			aria-label={ariaLabel ?? labels.aria}
			className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-[min(17rem,45dvh)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-3xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
			data-slot="mention-popup"
			data-trigger={trigger}
			role="listbox"
		>
			{candidates.length === 0 ? (
				<p className="px-3 py-2.5 text-muted-foreground text-sm" data-slot="mention-empty">
					{emptyLabel ?? labels.empty}
				</p>
			) : null}
			{candidates.map((candidate, index) => (
				<Fragment key={candidate.id}>
				{sectionTitle(candidates, index) ? (
					<p className="px-2.5 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide" data-slot="mention-section">
						{sectionTitle(candidates, index)}
					</p>
				) : null}
				<button
					aria-selected={index === activeIndex}
					className={cn(
						"flex min-h-11 w-full items-center gap-2.5 rounded-2xl px-2.5 py-1.5 text-left outline-none",
						index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
					)}
					onMouseDown={(event) => {
						// Mantém o foco no campo de texto.
						event.preventDefault();
						onPick(candidate);
					}}
					onMouseEnter={() => onHover?.(index)}
					ref={index === activeIndex ? activeRef : undefined}
					role="option"
					type="button"
				>
					{candidate.kind === "app" ? (
						<AppLogo className="size-[26px]" name={candidate.name} src={candidate.logo} />
					) : trigger === "/" ? (
						<span aria-hidden className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" data-kind={candidate.kind === "command" ? "command" : "skill"}>
							{candidate.kind === "command" ? <ShrinkIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
						</span>
					) : (
						<AgentAvatar animated={false} bodyColor={candidate.color} id={candidate.id} shape={candidate.shape} size={26} />
					)}
					<span className="min-w-0 flex-1">
						<span className="flex items-center gap-1.5">
							<span className="truncate font-medium text-sm">{trigger === "/" ? `/${candidate.name}` : candidate.name}</span>
							{candidate.isPrimary ? <span className="shrink-0 text-[10px] text-muted-foreground uppercase">principal</span> : null}
						</span>
						{candidate.description?.trim() ? (
							<span className="block truncate text-muted-foreground text-xs">{candidate.description.trim()}</span>
						) : null}
					</span>
					{candidate.kind === "app" ? (
						<span className={cn("shrink-0 text-xs", candidate.connected ? "text-muted-foreground" : "font-medium text-foreground")} data-slot="mention-app-status">
							{candidate.connected ? "Conectado" : "Entrar"}
						</span>
					) : null}
				</button>
				</Fragment>
			))}
		</div>
	);
}
