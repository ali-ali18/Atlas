import { useRouter } from "expo-router";
import * as React from "react";
import { SplashView } from "@/components/splash-screen";
import { useAtlasSession } from "@/lib/atlas-session";
import { useHomeData } from "@/lib/home-data";

const MIN_VISIBLE_MS = 900;

/**
 * Carregamento inicial (o mascote, sem texto). Confere a sessão com o servidor, busca bots e conversas, grava
 * no cache do aparelho e segue para a home (`app/(app)/index.tsx`). Com cache, abre na hora e a atualização
 * continua por trás. Sessão recusada (401) sai e volta ao Login (feito dentro do `prepare`); falha de rede sem
 * cache abre a home vazia com o aviso e o "Tentar de novo".
 */
export default function SyncingScreen() {
	const router = useRouter();
	const { markSynced } = useAtlasSession();
	const { prepare } = useHomeData();
	const started = React.useRef(false);

	React.useEffect(() => {
		if (started.current) return;
		started.current = true;
		const minimum = new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS));
		void (async () => {
			const outcome = await prepare();
			await minimum;
			if (outcome === "signed-out") return;
			markSynced();
			router.replace("/");
		})();
	}, [prepare, markSynced, router]);

	return <SplashView />;
}
