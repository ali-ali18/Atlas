"use client";

import { Button } from "@workspace/ui/components/button";
import { useState } from "react";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { imageFileUrl } from "./image-url";

export type ImageItem = { artifactId: string; mime: string; width: number; height: number; alt?: string; name?: string };

export function ImageCard({ item, onOpen }: { item: ImageItem; onOpen: () => void }) {
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const alt = item.alt?.trim() || "Imagem";
	return <Button aria-label={`Abrir imagem: ${alt}`} className="relative h-auto w-full overflow-hidden rounded-xl p-0" disabled={state === "error"} onClick={onOpen} type="button" variant="ghost">
		{state === "loading" && <Skeleton className="absolute inset-0" />}
		{state === "error" ? <span className="p-4 text-sm">Não foi possível abrir a imagem</span> : <img alt={alt} className="max-h-80 w-full object-contain" decoding="async" height={item.height || 320} loading="lazy" onError={() => setState("error")} onLoad={() => setState("ready")} src={imageFileUrl(item.artifactId)} width={item.width || 320} />}
	</Button>;
}
