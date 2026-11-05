import * as React from "react";
import { usePreferences } from "./app-preferences";
import type { AccountSettingsState } from "./use-account-settings";
import { deviceTimeZone, isAutoTimezone, timezoneToSync } from "./timezone";

/**
 * "Definir fuso horário automaticamente": ligado, o fuso da conta acompanha o do aparelho (grava em `general.timezone`,
 * em silêncio). A escolha fica no aparelho; sem escolha vale a inferência de `isAutoTimezone`. Cada fuso é tentado uma
 * vez por abertura da tela (se o servidor recusar, não fica repetindo).
 */
export function useAutoTimezone({ settings, change }: Pick<AccountSettingsState, "settings" | "change">) {
	const { preferences, loaded, update } = usePreferences();
	const device = React.useMemo(() => deviceTimeZone(), []);
	const account = settings?.timezone ?? null;
	const auto = isAutoTimezone(preferences.autoTimezone, account, device);
	const attempted = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (!loaded || !settings) return;
		const zone = timezoneToSync(auto, account, device);
		if (!zone || attempted.current === zone) return;
		attempted.current = zone;
		change({ timezone: zone }, { silent: true });
	}, [loaded, settings, auto, account, device, change]);
	const setAuto = React.useCallback(
		(value: boolean) => {
			update({ autoTimezone: value });
			// Ligou agora: acompanha o aparelho já (a tentativa anterior de outro fuso não conta).
			if (value) attempted.current = null;
		},
		[update],
	);
	return { auto, device, setAuto };
}
