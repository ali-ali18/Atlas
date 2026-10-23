"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

type HandlerMap = Record<string, (...args: never[]) => unknown>;

/**
 * Para cada chave, uma função fixa que chama a versão mais nova do handler (lida em `read()` na hora da
 * chamada). As linhas memoizadas recebem sempre as mesmas funções, mas o clique usa o estado atual.
 */
export function createStableHandlers<T extends HandlerMap>(keys: readonly (keyof T)[], read: () => T): T {
	const stable = {} as T;
	for (const key of keys) {
		const call = (...args: unknown[]) => {
			const handler = read()[key] as T[keyof T] | undefined;
			return handler ? Reflect.apply(handler, undefined, args) : undefined;
		};
		Object.assign(stable, { [key]: call });
	}
	return stable;
}

/**
 * Handlers com identidade estável entre renders (as chaves de `impl` não podem mudar). A versão mais nova é
 * guardada depois do commit; os handlers só são chamados em eventos, depois disso.
 */
export function useStableHandlers<T extends HandlerMap>(impl: T): T {
	const latest = useRef(impl);
	useLayoutEffect(() => {
		latest.current = impl;
	});
	const [stable] = useState(() => createStableHandlers(Object.keys(impl) as (keyof T)[], () => latest.current));
	return stable;
}

/**
 * Mesmo conteúdo (comparado por JSON) = mesma referência de antes. Para listas pequenas derivadas de dados
 * que trocam de referência com frequência (ex.: a lista de bots a cada prévia).
 */
export function useStructuralMemo<T>(value: T): T {
	const key = JSON.stringify(value);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return useMemo(() => value, [key]);
}
