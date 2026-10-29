"use client";

import { Button } from "@workspace/ui/components/button";
import { useState } from "react";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useT } from "@/lib/i18n/provider";
import { imageFileUrl } from "./image-url";

export type ImageItem = { artifactId: string; mime: string; width: number; height: number; alt?: string; name?: string };

/** Tile da fileira: tamanho fixo vindo do planejador, raio 12 e anel finíssimo. */
export function ImageCard({ item, width, height, label, overflowCount, onOpen }: { item: ImageItem; width: number; height: number; label?: string; overflowCount?: number; onOpen: () => void }) {
	const t = useT();
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const alt = item.alt?.trim() || t("aiElements.images.image");
	const folded = overflowCount ? overflowCount : 0;
	return <Button aria-label={label ?? (folded ? t("aiElements.images.openMore", { count: folded }) : t("aiElements.images.open", { alt }))} className="relative block shrink-0 grow-0 overflow-hidden rounded-xl p-0 shadow-[0_0_0_0.5px_var(--border)] hover:bg-transparent dark:hover:bg-transparent" disabled={state === "error"} onClick={onOpen} style={{ width, height }} type="button" variant="ghost">
		{state === "loading" && <Skeleton className="absolute inset-0" />}
		{state === "error" ? <span className="grid h-full place-items-center p-2 text-center text-xs whitespace-normal">{t("aiElements.images.openError")}</span> : <img alt={alt} className="block size-full object-cover" decoding="async" height={height} loading="lazy" onError={() => setState("error")} onLoad={() => setState("ready")} src={imageFileUrl(item.artifactId)} width={width} />}
		{folded > 0 && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-[22px] font-semibold tracking-[0.01em] text-white/95 tabular-nums">+{folded}</span>}
	</Button>;
}
