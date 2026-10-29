"use client";

import { useEffect, useState } from "react";

import { activeT } from "@/lib/i18n/active";
import type { OpenRouterModel } from "@workspace/shared";
import { listOpenRouterImageModels, listOpenRouterModels } from "@/lib/atlas-api";

let cache: OpenRouterModel[] | null = null;

export function useOpenRouterModels() {
	const [models, setModels] = useState<OpenRouterModel[]>(() => cache ?? []);
	const [loading, setLoading] = useState(!cache);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (cache) return;
		let cancelled = false;
		setLoading(true);
		listOpenRouterModels()
			.then((next) => {
				cache = next;
				if (!cancelled) {
					setModels(next);
					setError(null);
				}
			})
			.catch((err) => {
				if (cancelled) return;
				setError(
					err instanceof Error ? err.message : activeT("errors.loadModels"),
				);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { models, loading, error };
}

let imageCache: OpenRouterModel[] | null = null;

/** Modelos de geração de imagem; vazio se o catálogo falhar (a tela cai para a lista de chat filtrada). */
export function useOpenRouterImageModels() {
	const [models, setModels] = useState<OpenRouterModel[]>(() => imageCache ?? []);
	const [loading, setLoading] = useState(!imageCache);

	useEffect(() => {
		if (imageCache) return;
		let cancelled = false;
		listOpenRouterImageModels()
			.then((next) => {
				imageCache = next;
				if (!cancelled) setModels(next);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { models, loading };
}
