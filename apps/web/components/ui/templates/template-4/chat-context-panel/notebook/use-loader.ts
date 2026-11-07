"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LoadState<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T };

/**
 * Carrega uma lista ao montar e quando as dependências mudam. Resposta velha (troca de bot no meio) é descartada.
 * `reload` recarrega sem piscar a tela de "carregando" (a lista antiga fica até a nova chegar).
 */
export function useLoader<T>(load: () => Promise<T>, deps: readonly unknown[]): { state: LoadState<T>; reload: () => void; setData: (update: (current: T) => T) => void } {
	const [state, setState] = useState<LoadState<T>>({ status: "loading" });
	const ticket = useRef(0);
	const loadRef = useRef(load);
	loadRef.current = load;

	const reload = useCallback(() => {
		const mine = ++ticket.current;
		loadRef.current()
			.then((data) => {
				if (ticket.current === mine) setState({ status: "ready", data });
			})
			.catch(() => {
				if (ticket.current === mine) setState({ status: "error" });
			});
	}, []);

	useEffect(() => {
		setState({ status: "loading" });
		reload();
		return () => {
			ticket.current += 1;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);

	const setData = useCallback((update: (current: T) => T) => {
		setState((current) => (current.status === "ready" ? { status: "ready", data: update(current.data) } : current));
	}, []);

	return { state, reload, setData };
}
