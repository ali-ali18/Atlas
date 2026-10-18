"use client";

import { useEffect, useState } from "react";

import type { OpenRouterModel } from "@workspace/shared";
import { listOpenRouterModels } from "@/lib/atlas-api";

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
					err instanceof Error ? err.message : "Falha ao carregar modelos",
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
