"use client";

import { CircleAlertIcon, ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";

import { aspectRatioValue } from "@/lib/image-gen";

/** Altura máxima igual à da imagem final (`max-h-80` do ImageCard): a troca não muda o tamanho. */
const MAX_HEIGHT_REM = 20;

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds} s`;
	return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

export function ImagePendingCard({ aspectRatio, count, startedAt, status, error }: {
	aspectRatio: string;
	count: 1 | 2;
	startedAt: number;
	status: "running" | "error";
	error?: string;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (status !== "running") return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [status]);
	const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
	const ratio = aspectRatioValue(aspectRatio);
	const failed = status === "error";
	return <div className="mr-auto w-full max-w-sm" data-status={status} data-testid="image-pending">
		<div className={count === 1 ? "w-full" : "grid grid-cols-2 gap-2"}>
			{Array.from({ length: count }, (_, position) => <div
				aria-hidden
				className={cn("relative mr-auto w-full overflow-hidden rounded-xl", failed ? "border border-dashed border-border bg-muted/40" : "")}
				data-testid="image-pending-frame"
				key={position}
				style={{ aspectRatio: aspectRatio.replace(":", " / "), width: `min(100%, ${MAX_HEIGHT_REM * ratio}rem)` }}
			>
				{failed ? null : <Skeleton className="absolute inset-0 rounded-xl" />}
				<div className="absolute inset-0 grid place-items-center text-muted-foreground">
					{failed ? <CircleAlertIcon className="size-5 opacity-70" /> : <ImageIcon className="size-5 opacity-60" />}
				</div>
			</div>)}
		</div>
		<p aria-live="polite" className={cn("mt-1.5 text-xs", failed ? "text-destructive/80" : "text-muted-foreground")} role={failed ? "alert" : "status"}>
			{failed ? (error || "Não foi possível gerar a imagem.") : `${count === 2 ? "Gerando imagens…" : "Gerando imagem…"} ${formatElapsed(elapsed)}`}
		</p>
	</div>;
}
