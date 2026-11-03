// Habilidades do `/`: lidas uma vez, na primeira vez que a pessoa digita `/` (como no web, `useAddMenuSkills`). A
// decisão (juntar e filtrar) é pura em `skills-api.ts`; aqui só há estado e efeito.
import * as React from "react";
import { useAtlasSession } from "./atlas-session";
import { fetchSkills, type ComposerSkill } from "./skills-api";

export function useComposerSkills(): { skills: ComposerSkill[]; loading: boolean; load: () => void } {
	const { apiFetch } = useAtlasSession();
	const [skills, setSkills] = React.useState<ComposerSkill[]>([]);
	const [loading, setLoading] = React.useState(false);
	const started = React.useRef(false);
	const latest = React.useRef(apiFetch);
	latest.current = apiFetch;
	const load = React.useCallback(() => {
		if (started.current) return;
		started.current = true;
		setLoading(true);
		fetchSkills(latest.current)
			.then(setSkills)
			// Falhou (sem rede, sessão): o `/` mostra a lista vazia e a próxima vez que ele abrir tenta de novo.
			.catch(() => {
				started.current = false;
			})
			.finally(() => setLoading(false));
	}, []);
	return { skills, loading, load };
}
