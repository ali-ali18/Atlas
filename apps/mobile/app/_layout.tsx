import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { themeColor, themeVars } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

export default function RootLayout() {
	const scheme = useAppColorScheme();
	return (
		<SafeAreaProvider>
			<View style={[{ flex: 1 }, themeVars(scheme)]} className="bg-background">
				<StatusBar style={scheme === "dark" ? "light" : "dark"} />
				<Stack
					screenOptions={{
						headerShown: false,
						animation: "fade",
						contentStyle: { backgroundColor: themeColor(scheme, "background") },
					}}
				/>
			</View>
		</SafeAreaProvider>
	);
}
