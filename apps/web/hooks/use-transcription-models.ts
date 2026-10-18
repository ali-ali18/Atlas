"use client";

import { useEffect, useState } from "react";

import type { TranscriptionModelsResponse } from "@workspace/shared";
import { getTranscriptionModels } from "@/lib/atlas-api";

let cache: TranscriptionModelsResponse | null = null;

/**
 * Modelos de ditado. `data` fica `null` quando o servidor não tem STT (503) ou o
 * catálogo falhou: a tela esconde a configuração em vez de mostrar um seletor vazio.
 */
export function useTranscriptionModels() {
	const [data, setData] = useState<TranscriptionModelsResponse | null>(cache);
	const [loading, setLoading] = useState(!cache);

	useEffect(() => {
		if (cache) return;
		let cancelled = false;
		getTranscriptionModels()
			.then((next) => {
				cache = next;
				if (!cancelled) setData(next);
			})
			.catch(() => {
				if (!cancelled) setData(null);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { data, loading };
}
