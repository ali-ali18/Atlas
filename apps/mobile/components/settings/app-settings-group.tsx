import { useRouter } from "expo-router";
import { Linking } from "react-native";
import { SurfaceGroup } from "@/components/ui/surface-card";
import { usePreferences } from "@/lib/app-preferences";
import { themePreferenceLabel } from "@/lib/preferences";
import { NavRow, ToggleRow } from "./settings-rows";

/** Grupo "App": preferências só deste aparelho (aparência, retorno tátil) e o atalho para as notificações do sistema. */
export function AppSettingsGroup() {
	const router = useRouter();
	const { preferences, update } = usePreferences();
	return (
		<SurfaceGroup>
			<NavRow title="Aparência" value={themePreferenceLabel(preferences.theme)} onPress={() => router.push("/settings/appearance" as never)} />
			<ToggleRow title="Retorno tátil" value={preferences.haptics} onValueChange={(haptics) => update({ haptics })} />
			{/* As notificações do Atlas ainda não existem: a linha leva às configurações do sistema, onde o aparelho decide. */}
			<NavRow title="Notificações" subtitle="Em breve no Atlas" onPress={() => void Linking.openSettings().catch(() => undefined)} />
		</SurfaceGroup>
	);
}
