import * as React from "react";
import { OptionSheet } from "@/components/bot/option-sheet";
import { SurfaceGroup } from "@/components/ui/surface-card";
import { isAutonomyLevel, isBotLanguageSetting } from "@workspace/shared";
import { languageLabel, LANGUAGE_OPTIONS } from "@/lib/bot-edit";
import { AUTONOMY_OPTIONS, autonomySubtitle } from "@/lib/settings-format";
import { listTimeZones, timeZoneLabel, withExtras } from "@/lib/timezone";
import type { AccountSettingsState } from "@/lib/use-account-settings";
import { useAutoTimezone } from "@/lib/use-auto-timezone";
import { NavRow, ToggleRow } from "./settings-rows";
import { TimezoneSheet } from "./timezone-sheet";

/** Grupo "Bot": permissões, fuso (automático ou à mão), navegador do computador e idioma dos bots novos. Tudo salva na hora. */
export function BotSettingsGroup({ state }: { state: AccountSettingsState }) {
	const { settings, level, change, setLevel } = state;
	const { auto, device, setAuto } = useAutoTimezone(state);
	const [sheet, setSheet] = React.useState<"level" | "zone" | "language" | null>(null);
	const close = () => setSheet(null);
	// A hora que a lista mostra ("GMT-3") é a de agora, fixada na abertura da folha.
	const now = React.useMemo(() => new Date(), [sheet]);
	const zone = (auto ? device : null) ?? settings?.timezone ?? device;
	const zones = React.useMemo(() => withExtras(listTimeZones(), settings?.timezone, device), [settings?.timezone, device]);
	// Sem a conta lida não dá para editar: as linhas aparecem, mas só o que depende dela fica parado.
	const ready = settings !== null;
	return (
		<>
			<SurfaceGroup>
				<NavRow title="Permissões" subtitle={autonomySubtitle(level)} onPress={() => setSheet("level")} disabled={level === null} />
				<ToggleRow title="Definir fuso horário automaticamente" subtitle="O computador do seu bot segue o fuso horário deste aparelho." value={auto} onValueChange={setAuto} disabled={!ready || device === null} />
				<NavRow title="Fuso horário" value={zone ? timeZoneLabel(zone, now) : "—"} onPress={() => setSheet("zone")} chevron={false} disabled={!ready || auto} />
				<ToggleRow title="Computador do bot" subtitle="Abrir navegador automaticamente" value={settings?.sandboxAutoStart ?? true} onValueChange={(sandboxAutoStart) => change({ sandboxAutoStart })} disabled={!ready} />
				<NavRow title="Idioma dos bots novos" value={settings ? languageLabel(settings.botLanguage) : "—"} onPress={() => setSheet("language")} disabled={!ready} />
			</SurfaceGroup>
			<OptionSheet open={sheet === "level"} title="Permissões" options={AUTONOMY_OPTIONS} value={level ?? ""} onPick={(value) => (isAutonomyLevel(value) && setLevel(value), close())} onClose={close} />
			<OptionSheet open={sheet === "language"} title="Idioma dos bots novos" options={LANGUAGE_OPTIONS} value={settings?.botLanguage ?? ""} onPick={(value) => (isBotLanguageSetting(value) && change({ botLanguage: value }), close())} onClose={close} />
			<TimezoneSheet open={sheet === "zone"} zones={zones} value={settings?.timezone ?? null} now={now} onPick={(picked) => (change({ timezone: picked }), close())} onClose={close} />
		</>
	);
}
