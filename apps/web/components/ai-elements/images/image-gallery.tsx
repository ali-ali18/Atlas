"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { planImageRow } from "@/lib/image-row-plan";
import { ImageCard, type ImageItem } from "./image-card";
import { ImageLightbox } from "./image-lightbox";

/** Largura inicial (antes da medição): coluna de texto típica do chat. */
const INITIAL_WIDTH = 384;

/**
 * Imagens em sequência viram uma fileira justificada (mesma altura, +N na última
 * quando dobra). Clicar abre o visualizador na posição, com a galeria inteira.
 */
export function ImageGallery({ items, source, initialWidth = INITIAL_WIDTH }: { items: ImageItem[]; source: "user" | "assistant"; initialWidth?: number }) {
	const [index, setIndex] = useState<number | null>(null);
	const [width, setWidth] = useState(initialWidth);
	const rowRef = useRef<HTMLDivElement>(null);

	// Largura disponível = largura do contêiner da fileira.
	useEffect(() => {
		const element = rowRef.current;
		if (!element) return;
		const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const plan = useMemo(() => planImageRow({ sizes: items.map((item) => ({ width: item.width, height: item.height })), availableWidth: width }), [items, width]);
	if (items.length === 0) return null;
	return <div className={`flex w-full min-w-0 max-w-full items-start gap-1.5 ${source === "user" ? "justify-end" : "justify-start"}`} ref={rowRef}>
		{plan.tiles.map((tile, position) => {
			const last = position === plan.tiles.length - 1;
			return <ImageCard height={tile.height} item={items[tile.index]!} key={`${items[tile.index]!.artifactId}-${tile.index}`} onOpen={() => setIndex(tile.index)} overflowCount={last ? plan.foldedCount : 0} width={tile.width} />;
		})}
		<ImageLightbox index={index} items={items} onChange={setIndex} onClose={() => setIndex(null)} />
	</div>;
}
