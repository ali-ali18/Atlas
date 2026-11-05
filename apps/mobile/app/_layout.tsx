import "../global.css";

import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as React from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LaunchOverlay } from "@/components/launch/launch-overlay";
import { SplashView } from "@/components/splash-screen";
import { redirectFor } from "@/lib/auth-flow";
import { AtlasSessionProvider, useAtlasSession } from "@/lib/atlas-session";
import { HomeDataProvider } from "@/lib/home-data";
import { isAppReady } from "@/lib/launch-sequence";
import { surfaceColors } from "@/lib/surfaces";
import { themeVars } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// O splash nativo fica até a abertura animada (LaunchOverlay) estar desenhada, sem piscar entre os dois.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** Leva cada estado de acesso à sua tela: sem servidor, Conexão; sem sessão, Login; com sessão, o app. */
function AccessGate() {
	const { phase, synced } = useAtlasSession();
	const pathname = usePathname();
	const router = useRouter();
	const target = redirectFor(phase, pathname, synced);
	React.useEffect(() => {
		if (target) router.replace(target);
	}, [target, router]);
	// Enquanto confere o servidor salvo e a sessão do aparelho, o mascote cobre a tela (nada de tela errada piscando).
	return phase === "loading" ? (
		<View style={StyleSheet.absoluteFill} pointerEvents="auto">
			<SplashView />
		</View>
	) : null;
}

/** Abertura animada por cima do app: sai quando a rota certa já está na tela (home sincronizada, Login ou Conexão). */
function LaunchGate({ onShown }: { onShown: () => void }) {
	const { phase, synced } = useAtlasSession();
	const pathname = usePathname();
	return <LaunchOverlay ready={isAppReady({ phase, pathname, synced })} onShown={onShown} />;
}

/** Se a abertura não chegar a desenhar (erro inesperado), o splash nativo sai mesmo assim: o app nunca fica preso nele. */
const NATIVE_SPLASH_BACKSTOP_MS = 6000;

export default function RootLayout() {
	const scheme = useAppColorScheme();
	const hideNativeSplash = React.useCallback(() => {
		SplashScreen.hideAsync().catch(() => undefined);
	}, []);
	React.useEffect(() => {
		const timer = setTimeout(hideNativeSplash, NATIVE_SPLASH_BACKSTOP_MS);
		return () => clearTimeout(timer);
	}, [hideNativeSplash]);
	return (
		<SafeAreaProvider>
			<View style={[{ flex: 1 }, themeVars(scheme)]} className="bg-background">
				<StatusBar style={scheme === "dark" ? "light" : "dark"} />
				<AtlasSessionProvider>
					<HomeDataProvider>
						<Stack
							screenOptions={{
								headerShown: false,
								animation: "fade",
								contentStyle: { backgroundColor: surfaceColors(scheme).screen },
							}}
						/>
						<AccessGate />
						<LaunchGate onShown={hideNativeSplash} />
					</HomeDataProvider>
				</AtlasSessionProvider>
			</View>
		</SafeAreaProvider>
	);
}
