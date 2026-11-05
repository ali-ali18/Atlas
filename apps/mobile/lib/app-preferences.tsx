import * as React from "react";
import { Appearance } from "react-native";
import { setHapticsEnabled } from "./haptics";
import { DEFAULT_PREFERENCES, type Preferences } from "./preferences";
import { loadPreferences, savePreferences } from "./preferences-store";

type PreferencesContextValue = {
	preferences: Preferences;
	/** Já leu o que o aparelho guardou (antes disso os valores são os padrões, não a escolha do dono). */
	loaded: boolean;
	update: (patch: Partial<Preferences>) => void;
};

const Context = React.createContext<PreferencesContextValue | null>(null);

const FALLBACK: PreferencesContextValue = { preferences: DEFAULT_PREFERENCES, loaded: true, update: () => undefined };

/** Preferências do aparelho (tema, retorno tátil, fuso automático). Sem o provedor (telas soltas) valem os padrões. */
export function usePreferences(): PreferencesContextValue {
	return React.useContext(Context) ?? FALLBACK;
}

/** Lê o que o aparelho guardou, aplica (tema nativo e vibração) e grava a cada mudança. Fica acima de tudo no layout raiz. */
export function AppPreferencesProvider({ children }: { children: React.ReactNode }) {
	const [preferences, setPreferences] = React.useState<Preferences>(DEFAULT_PREFERENCES);
	// Só grava depois de ler: senão o padrão atropelaria o que está guardado.
	const loaded = React.useRef(false);
	const [ready, setReady] = React.useState(false);
	React.useEffect(() => {
		let alive = true;
		void loadPreferences().then((saved) => {
			if (!alive) return;
			loaded.current = true;
			setPreferences(saved);
			setReady(true);
		});
		return () => {
			alive = false;
		};
	}, []);
	React.useEffect(() => {
		setHapticsEnabled(preferences.haptics);
		try {
			// Faz diálogos e barras do sistema seguirem a escolha; "Sistema" devolve o controle ao aparelho.
			Appearance.setColorScheme(preferences.theme === "system" ? "unspecified" : preferences.theme);
		} catch {
			// plataforma sem suporte: o app ainda resolve o tema por `useAppColorScheme`
		}
	}, [preferences.haptics, preferences.theme]);
	const update = React.useCallback((patch: Partial<Preferences>) => {
		setPreferences((current) => {
			const next = { ...current, ...patch };
			if (loaded.current) void savePreferences(next);
			return next;
		});
	}, []);
	const value = React.useMemo(() => ({ preferences, loaded: ready, update }), [preferences, ready, update]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
