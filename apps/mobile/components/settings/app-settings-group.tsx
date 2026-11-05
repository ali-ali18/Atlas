import * as React from "react";
import { Linking } from "react-native";
import { OptionSheet } from "@/components/bot/option-sheet";
import { SurfaceGroup } from "@/components/ui/surface-card";
import { usePreferences } from "@/lib/app-preferences";
import { isThemePreference, THEME_OPTIONS, themePreferenceLabel } from "@/lib/preferences";
import { NavRow, ToggleRow } from "./settings-rows";

/** Grupo "App": preferências só deste aparelho (aparência, retorno tátil) e o atalho para as notificações do sistema. */
export function AppSettingsGroup() {
	const { preferences, update } = usePreferences();
	const [themeOpen, setThemeOpen] = React.useState(false);
	return (
		<>
			<SurfaceGroup>
				<NavRow title="Aparência" value={themePreferenceLabel(preferences.theme)} onPress={() => setThemeOpen(true)} />
				<ToggleRow title="Retorno tátil" value={preferences.haptics} onValueChange={(haptics) => update({ haptics })} />
				{/* As notificações do Atlas ainda não existem: a linha leva às configurações do sistema, onde o aparelho decide. */}
				<NavRow title="Notificações" subtitle="Em breve no Atlas" onPress={() => void Linking.openSettings().catch(() => undefined)} />
			</SurfaceGroup>
			<OptionSheet
				open={themeOpen}
				title="Aparência"
				options={THEME_OPTIONS}
				value={preferences.theme}
				onPick={(theme) => {
					if (isThemePreference(theme)) update({ theme });
					setThemeOpen(false);
				}}
				onClose={() => setThemeOpen(false)}
			/>
		</>
	);
}
