"use client";

import { useEffect, useState } from "react";
import { listSkills } from "@/lib/atlas-api";

/** Quantas habilidades a conta tem (lista mobile); `undefined` enquanto carrega ou se falhar. */
export function useSkillsCount(): number | undefined {
	const [count, setCount] = useState<number | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		listSkills()
			.then((skills) => {
				if (!cancelled) setCount(skills.length);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);
	return count;
}
