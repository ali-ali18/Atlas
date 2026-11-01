import { useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { Screen } from "@/components/screen";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";

const MIN_VISIBLE_MS = 1200;
const PROBE_TIMEOUT_MS = 8000;

/**
 * Entre o login e o app. Confere, com a sessão do aparelho, que o servidor aceita o acesso (GET /v1/bots, só leitura):
 * 401 quer dizer sessão que o servidor não reconhece, então sai e volta ao Login. Falha de rede não derruba a
 * sessão. Depois vai para a home (`app/(app)/index.tsx`).
 */
export default function SyncingScreen() {
	const router = useRouter();
	const { apiFetch, signOut, markSynced } = useAtlasSession();

	React.useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		const minimum = new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS));
		(async () => {
			let rejected = false;
			try {
				const response = await apiFetch("/v1/bots", { signal: controller.signal, headers: { accept: "application/json" } });
				rejected = response.status === 401;
			} catch {
				// sem rede ou demorou: segue com a sessão guardada
			}
			await minimum;
			if (cancelled) return;
			if (rejected) await signOut();
			else {
				markSynced();
				router.replace("/");
			}
		})();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			controller.abort();
		};
	}, [apiFetch, signOut, markSynced, router]);

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
