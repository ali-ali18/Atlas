"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@workspace/ui/components/dialog";
import type { ImageItem } from "./image-card";
import { imageFileUrl } from "./image-url";
import { fitImageSize } from "./image-viewer-size";

/** Botão redondo 32px, translúcido, no padrão do visualizador de referência. */
const viewerButton = "size-8 rounded-full border border-[#fcfcfc1a] bg-[#7777772c] p-0 text-[#fcfcfc99] hover:bg-[#77777752] hover:text-[#fcfcfc99] dark:hover:bg-[#77777752] focus-visible:ring-white/60";

export function ImageLightbox({ items, index, onChange, onClose }: { items: ImageItem[]; index: number | null; onChange: (index: number) => void; onClose: () => void }) {
	const [zoom, setZoom] = useState(1);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	const item = index === null ? undefined : items[index];
	const alt = item?.alt?.trim() || "Imagem";
	const caption = [item?.alt?.trim(), items.length > 1 && index !== null ? `${index + 1} / ${items.length}` : ""].filter(Boolean).join(" · ");
	const fitted = fitImageSize(item?.width || 800, item?.height || 800, bounds.width, bounds.height);
	const imageWidth = fitted.width * zoom;
	const imageHeight = fitted.height * zoom;
	const activeThumb = useRef<HTMLButtonElement | null>(null);
	const swipeStart = useRef<{ x: number; y: number } | null>(null);

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
		// Miniatura ativa sempre visível na tira (sem animação com movimento reduzido).
		const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		activeThumb.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: reduce ? "auto" : "smooth" });
	}, [index, viewport]);

	useEffect(() => {
		if (!viewport) return;
		const zoomWithWheel = (event: WheelEvent) => {
			if (!event.ctrlKey) return;
			event.preventDefault();
			setZoom((value) => Math.max(1, Math.min(5, value + (event.deltaY < 0 ? 0.25 : -0.25))));
		};
		// Listener não passivo evita o zoom do navegador apenas neste atalho.
		viewport.addEventListener("wheel", zoomWithWheel, { passive: false });
		return () => viewport.removeEventListener("wheel", zoomWithWheel);
	}, [viewport]);

	function navigate(direction: number) {
		if (index === null || items.length < 2) return;
		onChange((index + direction + items.length) % items.length);
	}

	// Swipe horizontal (celular) só navega sem zoom, para não competir com a rolagem da imagem ampliada.
	function endSwipe(x: number, y: number) {
		const start = swipeStart.current;
		swipeStart.current = null;
		if (!start || zoom > 1) return;
		const dx = x - start.x;
		if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(y - start.y) * 1.5) navigate(dx < 0 ? 1 : -1);
	}

	const closeOnBackground = (event: React.MouseEvent) => { if (event.target === event.currentTarget) onClose(); };

	return <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open={index !== null}>
		<DialogContent
			className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 cursor-zoom-out flex-col items-center gap-0 overflow-hidden rounded-none bg-transparent pt-11 pb-5 text-white shadow-none ring-0 sm:max-w-none dark:ring-0 data-open:zoom-in-100 data-closed:zoom-out-100"
			overlayClassName="bg-[#141414f2] backdrop-blur-none supports-backdrop-filter:bg-[#141414f2] supports-backdrop-filter:backdrop-blur-none"
			showCloseButton={false}
			onClick={closeOnBackground}
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
				<div className="absolute top-3 right-3 z-10 flex cursor-default gap-2">
					<Button aria-label="Diminuir zoom" className={viewerButton} disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.25))} size="icon-sm" variant="ghost"><MinusIcon /></Button>
					<Button aria-label="Aumentar zoom" className={viewerButton} disabled={zoom >= 5} onClick={() => setZoom((value) => Math.min(5, value + 0.25))} size="icon-sm" variant="ghost"><PlusIcon /></Button>
					<Button aria-label="Baixar imagem" className={viewerButton} nativeButton={false} render={<a download href={imageFileUrl(item.artifactId, true)} />} size="icon-sm" variant="ghost"><DownloadIcon /></Button>
					<DialogClose render={<Button aria-label="Fechar imagem" className={viewerButton} size="icon-sm" variant="ghost" />}><XIcon /></DialogClose>
				</div>
				<div
					className="relative min-h-0 w-full flex-1 px-4 py-4 sm:px-24 sm:py-9"
					onClick={closeOnBackground}
					onTouchEnd={(event) => { const touch = event.changedTouches[0]; if (touch) endSwipe(touch.clientX, touch.clientY); }}
					onTouchStart={(event) => { const touch = event.touches[0]; swipeStart.current = touch && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null; }}
				>
					<div
						aria-label="Área da imagem; use Ctrl e roda do mouse para ampliar e as setas para percorrer quando ampliada"
						className="h-full w-full overflow-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/60"
						ref={setViewport}
						role="region"
						tabIndex={0}
						onClick={closeOnBackground}
					>
						<div className="grid min-h-full min-w-full place-items-center" style={{ width: imageWidth, height: imageHeight }} onClick={closeOnBackground}>
							<img alt={alt} className="block max-w-none cursor-default rounded-xl object-contain select-none" decoding="async" draggable={false} height={item.height || 800} src={imageFileUrl(item.artifactId)} style={{ width: imageWidth, height: imageHeight }} width={item.width || 800} />
						</div>
					</div>
					{items.length > 1 && <>
						<Button aria-label="Imagem anterior" className={`absolute left-3 top-1/2 z-10 hidden -translate-y-1/2 sm:inline-flex ${viewerButton}`} onClick={() => navigate(-1)} size="icon-sm" variant="ghost"><ChevronLeftIcon /></Button>
						<Button aria-label="Próxima imagem" className={`absolute right-3 top-1/2 z-10 hidden -translate-y-1/2 sm:inline-flex ${viewerButton}`} onClick={() => navigate(1)} size="icon-sm" variant="ghost"><ChevronRightIcon /></Button>
					</>}
				</div>
				{caption && <p className="mt-[7px] mb-[21px] line-clamp-2 max-w-[min(80vw,720px)] cursor-default px-4 text-center text-sm text-[#fcfcfc8f]">{caption}</p>}
				{items.length > 1 && <div aria-label="Miniaturas" className="flex w-full max-w-110 cursor-default items-center gap-2 overflow-x-auto px-2 py-0.5 scrollbar-none" role="group">
					{items.map((thumb, position) => {
						const active = position === index;
						return <button
							aria-current={active}
							aria-label={`Ver imagem ${position + 1} de ${items.length}`}
							className={`box-border size-12 shrink-0 overflow-hidden rounded-lg border outline-none transition-opacity duration-150 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-white/60 ${active ? "border-2 border-[#fafafa] p-0.5 opacity-100" : "border-[#fcfcfc26] opacity-50 hover:opacity-85"}`}
							key={`${thumb.artifactId}-${position}`}
							onClick={() => onChange(position)}
							ref={active ? activeThumb : undefined}
							type="button"
						><img alt="" className={`size-full object-cover ${active ? "rounded-md" : ""}`} decoding="async" draggable={false} height={48} src={imageFileUrl(thumb.artifactId)} width={48} /></button>;
					})}
				</div>}
			</>}
		</DialogContent>
	</Dialog>;
}
