import { useFocusEffect } from "expo-router";
import * as React from "react";
import { useAtlasSession } from "./atlas-session";
import { installedKey, installedSlugs, type InstalledMap } from "./catalog-installed";
import { loadInstalled } from "./catalog-installed-store";
import { useHomeData } from "./home-data";

/** Slugs de bots do catálogo que este aparelho instalou e ainda estão na home; relido sempre que a tela volta ao foco. */
export function useInstalledSlugs(): ReadonlySet<string> {
	const { serverUrl, email } = useAtlasSession();
	const { snapshot } = useHomeData();
	const [installedMap, setInstalledMap] = React.useState<InstalledMap>({});
	const storageKey = serverUrl && email ? installedKey(serverUrl, email) : null;
	useFocusEffect(
		React.useCallback(() => {
			if (!storageKey) return;
			let active = true;
			void loadInstalled(storageKey).then((map) => active && setInstalledMap(map));
			return () => {
				active = false;
			};
		}, [storageKey]),
	);
	const botIds = React.useMemo(() => (snapshot?.bots ?? []).map((bot) => bot.id), [snapshot]);
	return React.useMemo(() => installedSlugs(installedMap, botIds), [installedMap, botIds]);
}
