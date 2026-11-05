export type FadeCurve = "default" | "linear";
export type FadeStop = { offset: number; opacity: number };

/**
 * Stops do degradê do `Fade`. `default` segura opacidade alta até 55% (chat); `linear` usa só 2 stops, uniformes ao longo
 * da altura (home e Configurações). `from="top"`: opaco em cima; `from="bottom"`: opaco embaixo.
 */
export function fadeStops(from: "top" | "bottom", curve: FadeCurve = "default"): FadeStop[] {
	const top = from === "top";
	if (curve === "linear") return [{ offset: 0, opacity: top ? 1 : 0 }, { offset: 1, opacity: top ? 0 : 1 }];
	return [
		{ offset: 0, opacity: top ? 1 : 0 },
		{ offset: 0.55, opacity: top ? 0.85 : 0.15 },
		{ offset: 1, opacity: top ? 0 : 1 },
	];
}
