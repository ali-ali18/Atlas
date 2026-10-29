"use client";

import { lazy, Suspense } from "react";
import type { ChartSpec } from "@workspace/shared";
import { ShareMenu } from "@/components/ai-elements/share/share-menu";
import { cn } from "@workspace/ui/lib/utils";

// O gráfico (visx + motion + d3) só é baixado quando a primeira resposta com gráfico aparece.
const Chart = lazy(() => import("@workspace/ui/components/chart").then((module) => ({ default: module.Chart })));

/** Espaço reservado com a altura do gráfico: sem salto de layout enquanto o código carrega ou o JSON chega. */
export function ChartPlaceholder({ label = "Gerando gráfico…", className }: { label?: string; className?: string }) {
	return (
		<div
			aria-live="polite"
			className={cn("my-2 flex h-[300px] w-full min-w-0 max-w-[min(68ch,100%)] items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground text-xs", className)}
			data-testid="chart-placeholder"
		>
			<span className="motion-safe:animate-pulse">{label}</span>
		</div>
	);
}

/** `share`: mostra "Compartilhar" (copiar imagem, baixar PNG) no cabeçalho do gráfico; o rodapé da imagem leva o nome do bot. */
export function LazyChart({ spec, className, share }: { spec: ChartSpec; className?: string; share?: { botName?: string | null } }) {
	return (
		<Suspense fallback={<ChartPlaceholder className={className} label="Carregando gráfico…" />}>
			<Chart
				actions={share ? <ShareMenu botName={share.botName} targetSelector='[data-slot="chart"]' title={spec.title ?? "Gráfico"} /> : undefined}
				className={className}
				spec={spec}
			/>
		</Suspense>
	);
}
