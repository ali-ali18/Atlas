import "../global.css";

import { Stack, usePathname, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as React from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { redirectFor } from "@/lib/auth-flow";
import { AtlasSessionProvider, useAtlasSession } from "@/lib/atlas-session";
import { themeColor, themeVars } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/** Leva cada estado de acesso à sua tela: sem servidor, Conexão; sem sessão, Login; com sessão, o app. */
function AccessGate() {
	const { phase, synced } = useAtlasSession();
	const pathname = usePathname();
	const router = useRouter();
	const target = redirectFor(phase, pathname, synced);
	React.useEffect(() => {
		if (target) router.replace(target);
	}, [target, router]);
	return null;
}

export default function RootLayout() {
	const scheme = useAppColorScheme();
	return (
		<SafeAreaProvider>
			<View style={[{ flex: 1 }, themeVars(scheme)]} className="bg-background">
				<StatusBar style={scheme === "dark" ? "light" : "dark"} />
				<AtlasSessionProvider>
					<AccessGate />
					<Stack
						screenOptions={{
							headerShown: false,
							animation: "fade",
							contentStyle: { backgroundColor: themeColor(scheme, "background") },
						}}
					/>
				</AtlasSessionProvider>
			</View>
		</SafeAreaProvider>
	);
}
