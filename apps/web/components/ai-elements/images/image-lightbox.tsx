"use client";

import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@workspace/ui/components/dialog";
import type { ImageItem } from "./image-card";
import { imageFileUrl } from "./image-url";
import { fitImageSize } from "./image-viewer-size";

const roundControl = "rounded-full bg-neutral-800 text-white hover:bg-neutral-700 dark:hover:bg-neutral-700 focus-visible:ring-white/60";

export function ImageLightbox({ items, index, onChange, onClose }: { items: ImageItem[]; index: number | null; onChange: (index: number) => void; onClose: () => void }) {
	const [zoom, setZoom] = useState(1);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	const item = index === null ? undefined : items[index];
	const alt = item?.alt?.trim() || "Imagem";
	const fitted = fitImageSize(item?.width || 800, item?.height || 800, bounds.width, bounds.height);
	const imageWidth = fitted.width * zoom;
	const imageHeight = fitted.height * zoom;

	useEffect(() => {
		if (!viewport) return;
		const measure = () => setBounds({ width: viewport.clientWidth, height: viewport.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [viewport]);

	useEffect(() => {
		setZoom(1);
		viewport?.scrollTo(0, 0);
	}, [index, viewport]);

	useEffect(() => {
		if (!viewport) return;
		const zoomWithWheel = (event: WheelEvent) => {
			if (!event.ctrlKey) return;
			event.preventDefault();
			setZoom((value) => Math.max(1, Math.min(4, value + (event.deltaY < 0 ? 0.25 : -0.25))));
		};
		// Listener não passivo evita o zoom do navegador apenas neste atalho.
		viewport.addEventListener("wheel", zoomWithWheel, { passive: false });
		return () => viewport.removeEventListener("wheel", zoomWithWheel);
	}, [viewport]);

	function navigate(direction: number) {
		if (index === null || items.length < 2) return;
		onChange((index + direction + items.length) % items.length);
	}

	return <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open={index !== null}>
		<DialogContent
			className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-transparent p-0 text-white shadow-none ring-0 sm:max-w-none dark:ring-0 data-open:zoom-in-100 data-closed:zoom-out-100"
			overlayClassName="bg-black/85 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
			showCloseButton={false}
			onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
			onKeyDown={(event) => {
				// A área ampliada usa as setas nativas para percorrer a imagem.
				if (event.target === viewport && zoom > 1) return;
				if (items.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
					event.preventDefault();
					navigate(event.key === "ArrowLeft" ? -1 : 1);
				}
			}}
		>
			<DialogTitle className="sr-only">{alt}</DialogTitle>
			{item && <>
				<div className="absolute top-4 right-4 z-10 flex gap-2">
					<Button aria-label="Baixar imagem" className={roundControl} nativeButton={false} render={<a download href={imageFileUrl(item.artifactId, true)} />} size="icon-lg" variant="ghost"><DownloadIcon /></Button>
					<DialogClose render={<Button aria-label="Fechar imagem" className={roundControl} size="icon-lg" variant="ghost" />}><XIcon /></DialogClose>
				</div>
				<div className="absolute inset-x-4 top-20 bottom-20 sm:inset-x-20 sm:top-16" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
					<div
						aria-label="Área da imagem; use Ctrl e roda do mouse para ampliar e as setas para percorrer quando ampliada"
						className="h-full w-full overflow-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/60"
						ref={setViewport}
						role="region"
						tabIndex={0}
						onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
					>
						<div className="grid min-h-full min-w-full place-items-center" style={{ width: imageWidth, height: imageHeight }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
							<img alt={alt} className="block max-w-none rounded-xl object-contain select-none" decoding="async" draggable={false} height={item.height || 800} src={imageFileUrl(item.artifactId)} style={{ width: imageWidth, height: imageHeight }} width={item.width || 800} />
						</div>
					</div>
				</div>
				{items.length > 1 && <>
					<Button aria-label="Imagem anterior" className={`absolute left-4 top-1/2 z-10 -translate-y-1/2 ${roundControl}`} onClick={() => navigate(-1)} size="icon-lg" variant="ghost"><ChevronLeftIcon /></Button>
					<Button aria-label="Próxima imagem" className={`absolute right-4 top-1/2 z-10 -translate-y-1/2 ${roundControl}`} onClick={() => navigate(1)} size="icon-lg" variant="ghost"><ChevronRightIcon /></Button>
				</>}
				<div aria-label="Controles de zoom" className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-800 p-1 text-white">
					<Button aria-label="Diminuir zoom" className="rounded-full bg-neutral-700 hover:bg-neutral-600 dark:hover:bg-neutral-600" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.25))} size="icon-sm" variant="ghost"><MinusIcon /></Button>
					<output aria-live="polite" className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</output>
					<Button aria-label="Aumentar zoom" className="rounded-full bg-neutral-700 hover:bg-neutral-600 dark:hover:bg-neutral-600" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.25))} size="icon-sm" variant="ghost"><PlusIcon /></Button>
				</div>
			</>}
		</DialogContent>
	</Dialog>;
}
