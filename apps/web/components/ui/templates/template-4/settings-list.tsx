"use client";

import type { ReactNode } from "react";
import { ArrowLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";
import type { SettingsIcon } from "./settings-picker";

/**
 * Lista de configurações no estilo "grupos de linhas": o fundo da página é um
 * tom mais escuro que as linhas, cada grupo é um bloco arredondado e as linhas
 * ficam separadas por 2px (aparece o fundo da página entre elas).
 */
export function SettingsGroup({
	className,
	children,
	label,
}: {
	className?: string;
	children: ReactNode;
	/** Rótulo opcional acima do grupo. */
	label?: string;
}) {
	return (
		<section className="flex flex-col gap-2" data-slot="settings-list-group">
			{label ? <h3 className="px-4 text-xs font-medium text-muted-foreground">{label}</h3> : null}
			<div className={cn("flex flex-col gap-0.5 overflow-hidden rounded-[20px]", className)}>{children}</div>
		</section>
	);
}

/**
 * Linha tocável: ícone, título, linha secundária (valor atual) e seta.
 * Sem `onClick` vira uma linha estática (útil para conteúdo dentro de um grupo).
 */
export function SettingsRow({
	icon: Icon,
	title,
	secondary,
	onClick,
	chevron = true,
	leading,
	className,
}: {
	icon?: SettingsIcon;
	title: string;
	secondary?: ReactNode;
	onClick?: () => void;
	chevron?: boolean;
	/** Substitui o ícone (ex.: avatar da conta). */
	leading?: ReactNode;
	className?: string;
}) {
	const body = (
		<>
			{leading ??
				(Icon ? <Icon aria-hidden className="size-6 shrink-0 text-muted-foreground" data-slot="settings-row-icon" /> : null)}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-base leading-tight">{title}</span>
				{secondary ? (
					<span className="truncate text-sm leading-snug text-muted-foreground" data-slot="settings-row-secondary">
						{secondary}
					</span>
				) : null}
			</span>
			{onClick && chevron ? (
				<ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground/70" />
			) : null}
		</>
	);
	const base = "flex min-h-14 w-full items-center gap-4 bg-card px-4 py-3 text-left";
	if (!onClick) {
		return (
			<div className={cn(base, className)} data-slot="settings-row">
				{body}
			</div>
		);
	}
	return (
		<button
			className={cn(
				base,
				"outline-none transition-colors active:bg-accent focus-visible:bg-accent hover:bg-accent/60",
				className,
			)}
			data-slot="settings-row"
			onClick={onClick}
			type="button"
		>
			{body}
		</button>
	);
}

/** Página cheia: cabeçalho com voltar/fechar e título centralizado + conteúdo rolável. */
export function SettingsPage({
	title,
	onBack,
	backLabel,
	icon = "back",
	titleSlot,
	children,
}: {
	title: string;
	onBack: () => void;
	backLabel: string;
	icon?: "back" | "close";
	/** Permite o título ser o `DialogTitle` do contexto. */
	titleSlot?: (title: string) => ReactNode;
	children: ReactNode;
}) {
	const Icon = icon === "back" ? ArrowLeftIcon : XIcon;
	return (
		<div className="flex h-full min-h-0 flex-col bg-muted/40 dark:bg-background" data-slot="settings-page">
			<header className="grid shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
				<button
					aria-label={backLabel}
					className="flex size-11 items-center justify-center rounded-full text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30"
					onClick={onBack}
					type="button"
				>
					<Icon aria-hidden className="size-6" />
				</button>
				<div className="truncate text-center font-heading text-base font-semibold">
					{titleSlot ? titleSlot(title) : title}
				</div>
				<span />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
				{children}
			</div>
		</div>
	);
}
