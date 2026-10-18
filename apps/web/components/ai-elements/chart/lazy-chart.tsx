"use client";

import { lazy, Suspense } from "react";
import type { ChartSpec } from "@workspace/shared";

// O gráfico (visx + motion + d3) só é baixado quando a primeira resposta com gráfico aparece.
const Chart = lazy(() => import("@workspace/ui/components/chart").then((module) => ({ default: module.Chart })));

/** Espaço reservado com a altura do gráfico: sem salto de layout enquanto o código carrega ou o JSON chega. */
export function ChartPlaceholder({ label = "Gerando gráfico…" }: { label?: string }) {
	return (
		<div
			aria-live="polite"
			className="my-2 flex h-[300px] w-[min(68ch,calc(100vw-5rem))] min-w-0 max-w-full items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-muted-foreground text-xs"
			data-testid="chart-placeholder"
		>
			<span className="motion-safe:animate-pulse">{label}</span>
		</div>
	);
}

export function LazyChart({ spec }: { spec: ChartSpec }) {
	return (
		<Suspense fallback={<ChartPlaceholder label="Carregando gráfico…" />}>
			<Chart spec={spec} />
		</Suspense>
	);
}
