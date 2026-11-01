import { View } from "react-native";
import { Screen } from "@/components/screen";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";

export default function SyncingScreen() {
	return (
		<Screen scroll={false}>
			<View className="flex-1 items-center justify-center gap-4 px-6">
				<Spinner size="large" tone="foreground" label="Sincronizando" />
				<Text variant="heading">Sincronizando…</Text>
				<Text variant="muted">buscando conversas</Text>
			</View>
		</Screen>
	);
}
