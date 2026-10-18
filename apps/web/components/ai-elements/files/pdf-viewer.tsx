"use client";

import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import { Button } from "@workspace/ui/components/button";

// O worker precisa ser configurado no mesmo módulo que renderiza o <Document>.
// Build "legacy": tem polyfills (o padrão quebra em Chrome/Android mais antigo).
pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

const ZOOM_STEPS = [0.6, 0.8, 1, 1.25, 1.5, 2];

/** Visualizador de PDF (pdf.js) com paginação "1 / N" e zoom +/-. */
export default function PdfViewer({ url }: { url: string }) {
	const [pages, setPages] = useState(0);
	const [page, setPage] = useState(1);
	const [zoomIndex, setZoomIndex] = useState(2);
	const [error, setError] = useState<string | null>(null);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center justify-center gap-2 text-sm">
				<Button aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} size="icon-sm" type="button" variant="ghost">
					<ChevronLeftIcon />
				</Button>
				<span aria-live="polite">{pages ? `${page} / ${pages}` : "…"}</span>
				<Button aria-label="Próxima página" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} size="icon-sm" type="button" variant="ghost">
					<ChevronRightIcon />
				</Button>
				<Button aria-label="Diminuir zoom" disabled={zoomIndex <= 0} onClick={() => setZoomIndex((z) => z - 1)} size="icon-sm" type="button" variant="ghost">
					<MinusIcon />
				</Button>
				<Button aria-label="Aumentar zoom" disabled={zoomIndex >= ZOOM_STEPS.length - 1} onClick={() => setZoomIndex((z) => z + 1)} size="icon-sm" type="button" variant="ghost">
					<PlusIcon />
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 justify-center overflow-auto rounded-lg bg-muted/40 p-3">
				{error ? (
					<p className="text-destructive text-sm">{error}</p>
				) : (
					<Document
						file={url}
						loading={<p className="text-muted-foreground text-sm">Carregando PDF…</p>}
						onLoadError={() => setError("Não foi possível abrir o PDF. Baixe o arquivo.")}
						onLoadSuccess={({ numPages }) => setPages(numPages)}
						options={{ withCredentials: true }}
					>
						<Page pageNumber={page} scale={ZOOM_STEPS[zoomIndex]} />
					</Document>
				)}
			</div>
		</div>
	);
}
