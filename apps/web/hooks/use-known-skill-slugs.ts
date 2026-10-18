"use client";

import { useEffect, useState } from "react";

import { listBuiltinSkills, listSkills } from "@/lib/atlas-api";

let cache: Promise<ReadonlySet<string>> | null = null;

/** Nomes (slug) das skills da conta e de fábrica; uma busca por sessão, falha vira conjunto vazio. */
function loadKnownSkillSlugs(): Promise<ReadonlySet<string>> {
	cache ??= Promise.allSettled([listSkills(), listBuiltinSkills()]).then(([mine, factory]) => {
		const slugs = new Set<string>();
		if (mine.status === "fulfilled") for (const skill of mine.value) slugs.add(skill.name);
		if (factory.status === "fulfilled") for (const skill of factory.value) slugs.add(skill.slug);
		return slugs;
	});
	return cache;
}

/** Slugs conhecidos para desenhar `/skill` como chip nos balões (indefinido até carregar). */
export function useKnownSkillSlugs(enabled: boolean): ReadonlySet<string> | undefined {
	const [slugs, setSlugs] = useState<ReadonlySet<string> | undefined>();
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		void loadKnownSkillSlugs().then((next) => {
			if (alive) setSlugs(next);
		});
		return () => {
			alive = false;
		};
	}, [enabled]);
	return slugs;
}
