"use client";

import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, GlobeIcon, SearchIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@workspace/ui/components/popover";
import { cn } from "@workspace/ui/lib/utils";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { useT } from "@/lib/i18n/provider";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";
import type { SaveStatus } from "../account-settings-state";
import {
	detectedTimeZone,
	filterTimeZones,
	listTimeZones,
	shownTimeZone,
	timeZoneCity,
	timeZoneLabel,
} from "../timezone-state";

const MAX_LISTED = 80;

/**
 * Fuso horário da conta (pesquisável). Sem escolha, vale o do navegador ("automático").
 * Rotinas e o modo proativo leem este fuso como padrão. Cada escolha salva na hora.
 */
export function TimezoneSettingsView({
	value,
	detected,
	onChange,
	status,
	saveError,
	disabled = false,
	zones,
	isVisible = () => true,
}: {
	/** Fuso salvo na conta; `undefined` = automático. */
	value: string | undefined;
	detected: string | undefined;
	/** `null` = voltar ao automático. */
	onChange: (zone: string | null) => void;
	status: SaveStatus;
	saveError?: string | null;
	disabled?: boolean;
	zones?: readonly string[];
	isVisible?: (itemId: string) => boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const all = useMemo(() => zones ?? listTimeZones(), [zones]);
	const shown = shownTimeZone(value, detected);
	const matches = useMemo(() => filterTimeZones(all, query).slice(0, MAX_LISTED), [all, query]);
	if (!isVisible("geral.fuso")) return null;

	function choose(zone: string | null) {
		onChange(zone);
		setOpen(false);
		setQuery("");
	}

	return (
		<SettingsGroup title={t("settings.timezone.group")}>
			<SettingRow
				caption={<SaveIndicator error={saveError} status={status} />}
				control="inline"
				description={t("settings.timezone.hint")}
				icon={GlobeIcon}
				label={t("settings.timezone.label")}
			>
				<Popover
					onOpenChange={(next) => {
						setOpen(next);
						if (!next) setQuery("");
					}}
					open={open}
				>
					<PopoverTrigger
						aria-label={t("settings.timezone.label")}
						className="flex h-7 max-w-full items-center gap-1 rounded-md px-2 text-body outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
						disabled={disabled}
						type="button"
					>
						<span className="truncate">
							{timeZoneLabel(shown.zone)}
							{shown.auto ? ` · ${t("settings.timezone.automatic")}` : ""}
						</span>
						<ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
					</PopoverTrigger>
					<PopoverContent align="end" className="w-80 gap-2 rounded-xl p-1.5">
						<div className="relative">
							<SearchIcon
								aria-hidden
								className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							/>
							<input
								aria-label={t("settings.timezone.searchAria")}
								autoFocus
								className="h-8 w-full rounded-lg bg-input/50 pr-2 pl-8 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
								onChange={(event) => setQuery(event.target.value)}
								placeholder={t("settings.timezone.searchPlaceholder")}
								value={query}
							/>
						</div>
						<ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto" role="listbox">
							{!query.trim() ? (
								<ZoneOption
									label={detected ? t("settings.timezone.detectCity", { city: timeZoneCity(detected) }) : t("settings.timezone.detect")}
									onChoose={() => choose(null)}
									selected={shown.auto}
								/>
							) : null}
							{matches.map((zone) => (
								<ZoneOption
									key={zone}
									label={timeZoneLabel(zone)}
									meta={zone}
									onChoose={() => choose(zone)}
									selected={!shown.auto && shown.zone === zone}
								/>
							))}
							{matches.length === 0 ? (
								<li className="px-2.5 py-2 text-body text-muted-foreground" role="status">
									{t("settings.timezone.none")}
								</li>
							) : null}
						</ul>
					</PopoverContent>
				</Popover>
			</SettingRow>
		</SettingsGroup>
	);
}

function ZoneOption({
	label,
	meta,
	selected,
	onChoose,
}: {
	label: string;
	meta?: string;
	selected: boolean;
	onChoose: () => void;
}) {
	return (
		<li role="presentation">
			<button
				aria-selected={selected}
				className={cn(
					"flex min-h-[30px] w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body outline-none hover:bg-accent focus-visible:bg-accent",
					selected && "font-medium",
				)}
				onClick={onChoose}
				role="option"
				type="button"
			>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{meta ? <span className="shrink-0 text-xs text-muted-foreground">{meta.split("/")[0]}</span> : null}
				{selected ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
			</button>
		</li>
	);
}

export function TimezoneSettings({
	account,
	isVisible,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
}) {
	return (
		<TimezoneSettingsView
			detected={detectedTimeZone()}
			disabled={!account.view}
			isVisible={isVisible}
			onChange={(zone) => void account.save({ general: { timezone: zone } })}
			saveError={account.saveError}
			status={account.status}
			value={account.view?.effective.general.timezone.value}
		/>
	);
}
