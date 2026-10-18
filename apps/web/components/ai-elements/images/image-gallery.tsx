"use client";

import { useState } from "react";
import { ImageCard, type ImageItem } from "./image-card";
import { ImageLightbox } from "./image-lightbox";

export function ImageGallery({ items, source }: { items: ImageItem[]; source: "user" | "assistant" }) {
	const [index, setIndex] = useState<number | null>(null);
	if (items.length === 0) return null;
	return <div className={source === "user" ? "ml-auto w-fit max-w-sm" : "mr-auto w-fit max-w-sm"}>
		<div className={items.length === 1 ? "w-full" : "grid grid-cols-2 gap-2"}>
			{items.slice(0, 6).map((item, position) => <div className="relative" key={`${item.artifactId}-${position}`}>
				<ImageCard item={item} onOpen={() => setIndex(position)} />
				{position === 5 && items.length > 6 && <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-black/60 text-lg text-white">+{items.length - 6}</span>}
			</div>)}
		</div>
		<ImageLightbox index={index} items={items} onChange={setIndex} onClose={() => setIndex(null)} />
	</div>;
}
