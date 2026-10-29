"use client";

import { Fragment, type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import {
	ActivityIcon,
	ShieldCheckIcon,
	BellIcon,
	BotIcon,
	ChartColumnIcon,
	BrainIcon,
	CreditCardIcon,
	GaugeIcon,
	MonitorIcon,
	PlugIcon,
	SearchIcon,
	KeyRoundIcon,
	SparklesIcon,
	SettingsIcon,
	UserIcon,
	type LucideIcon,
} from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";
import { useT } from "@/lib/i18n/provider";
import { Input } from "@workspace/ui/components/input";
import { SettingsPicker } from "@/components/ui/templates/template-4/settings-picker";
import {
	navGroupLabel,
	navSectionLabel,
	type SettingsNavEntry,
	type SettingsNavId,
	type SettingsSearchResult,
	type SettingsSectionId,
	moveIndex,
	searchSettings,
} from "./settings-registry";

/** Ícone por seção: toda entrada visível tem o seu (o texto alinha igual). */
export const NAV_ICONS: Record<SettingsNavId, LucideIcon> = {
	conta: UserIcon,
	geral: SettingsIcon,
	provedores: CreditCardIcon,
	modelos: BrainIcon,
	execucao: GaugeIcon,
	bots: BotIcon,
	notificacoes: BellIcon,
	computador: MonitorIcon,
	conexoes: PlugIcon,
	cofre: KeyRoundIcon,
	habilidades: SparklesIcon,
	uso: ChartColumnIcon,
	revisao: ShieldCheckIcon,
	diagnostico: ActivityIcon,
};

/**
 * Casca do modal (estilo Grok): busca + nav à esquerda (198px), painel que rola à direita.
 * Não conhece Dialog nem URL (o `SettingsDialog` cuida disso), então renderiza em teste.
 * Em tela estreita a nav vira um dropdown no topo.
 */
export function SettingsShell({
	section,
	onSectionChange,
	header,
	initialQuery = "",
	hiddenItems,
	children,
}: {
	section: SettingsSectionId;
	onSectionChange: (section: SettingsSectionId) => void;
	/** Linha de título + botão de fechar (precisa do contexto do Dialog). */
	header: ReactNode;
	initialQuery?: string;
	/** Itens que o usuário não pode usar (ex.: o plano ChatGPT para quem não é dono). */
	hiddenItems?: ReadonlySet<string>;
	children: (context: { search: SettingsSearchResult }) => ReactNode;
}) {
	const t = useT();
	const [query, setQuery] = useState(initialQuery);
	const navRef = useRef<HTMLElement>(null);
	const search = searchSettings(query, hiddenItems, (id) => navSectionLabel(t, id));

	function navButtons(): HTMLButtonElement[] {
		return Array.from(
			navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav-item]") ?? [],
		);
	}

	function onNavKeyDown(event: KeyboardEvent<HTMLElement>) {
		const keys = { ArrowDown: "next", ArrowUp: "prev", Home: "first", End: "last" } as const;
		const move = keys[event.key as keyof typeof keys];
		if (!move) return;
		const buttons = navButtons();
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		event.preventDefault();
		buttons[moveIndex(current, buttons.length, move)]?.focus();
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col md:flex-row">
			<aside className="flex shrink-0 flex-col gap-3 border-b border-border/60 bg-muted/40 p-3 md:w-[198px] md:border-r md:border-b-0 md:px-3 md:py-4">
				<div className="relative">
					<SearchIcon
						aria-hidden
						className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						aria-label={t("settings.searchLabel")}
						className="h-8 pl-8 text-body"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "ArrowDown") return;
							event.preventDefault();
							navButtons()[0]?.focus();
						}}
						placeholder={t("settings.searchPlaceholder")}
						type="search"
						value={query}
					/>
				</div>

				<div className="md:hidden">
					{search.entries.length > 0 ? (
						<SettingsPicker
							aria-label={t("settings.sectionPickerLabel")}
							className="w-full"
							onChange={(id) => {
								const entry = search.entries.find((item) => item.id === id);
								if (entry) onSectionChange(entry.id);
							}}
							options={search.entries.map((entry) => ({ value: entry.id, label: navSectionLabel(t, entry.id) }))}
							value={search.entries.some((entry) => entry.id === section) ? section : ""}
							placeholder={t("settings.sectionPickerPlaceholder")}
						/>
					) : (
						<NothingFound />
					)}
				</div>

				<nav
					aria-label={t("settings.navLabel")}
					className="hidden min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto md:flex"
					onKeyDown={onNavKeyDown}
					ref={navRef}
				>
					{search.entries.length === 0 ? <NothingFound /> : null}
					{search.entries.map((entry, index) => (
						<Fragment key={entry.id}>
							{index === 0 || search.entries[index - 1]?.group !== entry.group ? (
								<p
									className={cn("px-[9px] pb-1 text-caption font-medium text-muted-foreground", index === 0 ? "pt-0.5" : "pt-3.5")}
									data-nav-group=""
								>
									{navGroupLabel(t, entry.group)}
								</p>
							) : null}
							<NavButton
								active={entry.id === section}
								entry={entry}
								onChoose={(chosen) => onSectionChange(chosen.id)}
							/>
						</Fragment>
					))}
				</nav>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="settings-panel">
				{header}
				<div className="min-h-0 flex-1 overflow-y-auto px-8 pt-[22px] pb-7">{children({ search })}</div>
			</section>
		</div>
	);
}

function NothingFound() {
	const t = useT();
	return (
		<p className="px-3 py-2 text-sm text-muted-foreground" role="status">
			{t("settings.nothingFound")}
		</p>
	);
}

function NavButton({
	entry,
	active,
	onChoose,
}: {
	entry: SettingsNavEntry;
	active: boolean;
	onChoose: (entry: SettingsNavEntry) => void;
}) {
	const t = useT();
	const Icon = NAV_ICONS[entry.id];
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex w-full items-center gap-[9px] rounded-lg px-[9px] py-[7px] text-left text-body text-foreground outline-none transition-colors duration-100",
				"hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50",
				active && "bg-accent font-medium",
			)}
			data-nav-item=""
			onClick={() => onChoose(entry)}
			type="button"
		>
			<Icon aria-hidden className="size-[15px] shrink-0" data-nav-icon="" />
			<span className="truncate">{navSectionLabel(t, entry.id)}</span>
		</button>
	);
}
