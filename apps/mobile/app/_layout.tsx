import "../global.css";

import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as React from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SplashView } from "@/components/splash-screen";
import { redirectFor } from "@/lib/auth-flow";
import { AtlasSessionProvider, useAtlasSession } from "@/lib/atlas-session";
import { HomeDataProvider } from "@/lib/home-data";
import { themeColor, themeVars } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// O splash nativo fica até a primeira tela do app desenhar (abaixo), sem piscar entre os dois.
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

export default function RootLayout() {
	const scheme = useAppColorScheme();
	const hideNativeSplash = React.useCallback(() => {
		SplashScreen.hideAsync().catch(() => undefined);
	}, []);
	return (
		<SafeAreaProvider>
			<View style={[{ flex: 1 }, themeVars(scheme)]} className="bg-background" onLayout={hideNativeSplash}>
				<StatusBar style={scheme === "dark" ? "light" : "dark"} />
				<AtlasSessionProvider>
					<HomeDataProvider>
						<Stack
							screenOptions={{
								headerShown: false,
								animation: "fade",
								contentStyle: { backgroundColor: themeColor(scheme, "background") },
							}}
						/>
						<AccessGate />
					</HomeDataProvider>
				</AtlasSessionProvider>
			</View>
		</SafeAreaProvider>
	);
}
