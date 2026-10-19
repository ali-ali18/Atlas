"use client";

import { useEffect, useState } from "react";
import { registeredTierModels } from "@workspace/shared";
import { getAccountSettings } from "@/lib/atlas-api";

let cached: string[] = [];

/**
 * Modelos cadastrados nos níveis de dificuldade da conta (sem repetição, Fácil a Difícil).
 * Vazio enquanto carrega ou se a leitura falhar: o seletor só não mostra o grupo.
 */
export function useAccountModelTiers(): string[] {
	const [ids, setIds] = useState<string[]>(cached);
	useEffect(() => {
		let cancelled = false;
		getAccountSettings()
			.then((view) => {
				cached = registeredTierModels(view.effective.models.tiers.value);
				if (!cancelled) setIds(cached);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return ids;
}
