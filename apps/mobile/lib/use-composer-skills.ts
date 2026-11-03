// Habilidades do `/`: lidas na primeira vez que a pessoa digita `/` (como no web, `useAddMenuSkills`). A decisão (juntar,
// completo ou não) é pura em `skills-api.ts`; aqui só há estado e efeito. Resultado parcial (uma das listas falhou) é
// mostrado, mas não vira definitivo: a próxima vez que o `/` abre lê de novo. Sessão recusada (401) encerra a sessão.
import * as React from "react";
import { useAtlasSession } from "./atlas-session";
import { isUnauthorized } from "./chat-api";
import { fetchSkills, type ComposerSkill } from "./skills-api";

export type ComposerSkillsState = { skills: ComposerSkill[]; loading: boolean; /** As duas listas falharam. */ failed: boolean; load: () => void };

export function useComposerSkills(): ComposerSkillsState {
	const { apiFetch, signOut } = useAtlasSession();
	const [skills, setSkills] = React.useState<ComposerSkill[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [failed, setFailed] = React.useState(false);
	// `done`: leitura completa; `busy`: uma em andamento.
	const done = React.useRef(false);
	const busy = React.useRef(false);
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };
	const load = React.useCallback(() => {
		if (done.current || busy.current) return;
		busy.current = true;
		setLoading(true);
		setFailed(false);
		fetchSkills(latest.current.apiFetch)
			.then((result) => {
				setSkills(result.skills);
				done.current = result.complete;
			})
			.catch((reason) => {
				if (isUnauthorized(reason)) void latest.current.signOut();
				else setFailed(true);
			})
			.finally(() => {
				busy.current = false;
				setLoading(false);
			});
	}, []);
	return { skills, loading, failed, load };
}
