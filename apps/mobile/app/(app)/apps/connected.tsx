import { useFocusEffect, useRouter } from "expo-router";
import * as React from "react";
import { FlatList, View } from "react-native";
import { AppRowView } from "@/components/apps/apps-view";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { type AppItem, appRouteParams, connectedItems } from "@/lib/apps";
import { useAppsData } from "@/lib/use-apps-data";

/** "Seus aplicativos": só os conectados (nativos, próprios e do Composio). Tocar abre o detalhe, onde ficam as informações e o Desconectar. */
export default function ConnectedAppsScreen() {
	const router = useRouter();
	const data = useAppsData();
	const { reload } = data;
	useFocusEffect(
		React.useCallback(() => {
			void reload();
		}, [reload]),
	);
	const items = React.useMemo(() => connectedItems({ entries: data.entries, connections: data.connections, composioConnections: data.composioConnections }), [data.entries, data.connections, data.composioConnections]);
	const open = React.useCallback((item: AppItem) => router.push({ pathname: "/apps/[id]", params: appRouteParams(item) } as never), [router]);
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	let empty: React.ReactElement | undefined;
	if (data.status === "loading") {
		empty = (
			<View className="items-center pt-24">
				<Spinner size="large" label="Carregando" />
			</View>
		);
	}
	else if (data.status === "error") {
		empty = (
			<Text variant="muted" className="px-8 pt-24 text-center text-control">
				{data.error}
			</Text>
		);
	} else {
		empty = (
			<Text variant="muted" className="px-8 pt-24 text-center text-control">
				Você ainda não conectou nenhum aplicativo.
			</Text>
		);
	}
	return (
		<ScreenFrame>
			<ScreenHeader title="Seus aplicativos" onBack={back} />
			<FlatList data={items} keyExtractor={(item) => item.key} renderItem={({ item }) => <AppRowView item={item} onOpen={() => open(item)} />} ListEmptyComponent={empty} contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 }} />
		</ScreenFrame>
	);
}
