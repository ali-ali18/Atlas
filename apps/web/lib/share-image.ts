/**
 * Exportar gráfico/painel como imagem (copiar, baixar PNG, baixar PDF). A parte pura (nome de arquivo, rodapé,
 * montagem do PDF) é testada; a parte de navegador (desenhar o nó, área de transferência) fica em `renderShareCanvas`
 * e `deliverImage`. Sem dependência pesada: o desenho usa `html-to-image` e o PDF é montado à mão (uma página com
 * a imagem em JPEG).
 */

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "23/10/2026" no relógio local. */
export function shareDateLabel(now: Date): string {
	return `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
}

/** Rodapé da imagem: "Nome do bot · 23/10/2026" (só a data quando não há nome). */
export function shareFooterText(botName: string | null | undefined, now: Date): string {
	const name = botName?.trim();
	return name ? `${name} · ${shareDateLabel(now)}` : shareDateLabel(now);
}

/** Nome de arquivo seguro: título sem acento nem símbolos + data (AAAA-MM-DD) + extensão. */
export function shareFileName(title: string | null | undefined, extension: "png" | "pdf", now: Date): string {
	const slug = (title ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return `${slug || "atlas"}-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.${extension}`;
}

const ascii = (text: string) => new TextEncoder().encode(text);

/** PDF de uma página com a imagem JPEG inteira (1 px = 0,75 pt, como na tela a 96 dpi). */
export function buildPdfFromJpeg(jpeg: Uint8Array, widthPx: number, heightPx: number): Uint8Array {
	const width = Math.max(1, Math.round(widthPx));
	const height = Math.max(1, Math.round(heightPx));
	const pageW = Math.round(width * 0.75 * 100) / 100;
	const pageH = Math.round(height * 0.75 * 100) / 100;
	const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
	const parts: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (chunk: Uint8Array) => {
		parts.push(chunk);
		length += chunk.length;
	};
	const object = (id: number, head: string, body?: Uint8Array, tail = "") => {
		offsets[id] = length;
		push(ascii(`${id} 0 obj\n${head}`));
		if (body) {
			push(ascii("\nstream\n"));
			push(body);
			push(ascii("\nendstream"));
		}
		push(ascii(`${tail}\nendobj\n`));
	};
	push(ascii("%PDF-1.4\n"));
	object(1, "<< /Type /Catalog /Pages 2 0 R >>");
	object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
	object(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
	object(5, `<< /Length ${content.length} >>`, ascii(content));
	const xrefAt = length;
	let xref = `xref\n0 6\n0000000000 65535 f \n`;
	for (let id = 1; id <= 5; id += 1) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	push(ascii(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** "data:image/jpeg;base64,..." → bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
	const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export type ShareRenderOptions = {
	botName?: string | null;
	now?: Date;
	/** Resolução da imagem (2 = nítida em telas retina). */
	pixelRatio?: number;
};

const FOOTER_HEIGHT = 36;

/** Primeira cor de fundo opaca do nó para cima (o diálogo e o cartão têm fundo próprio); branco se não achar. */
export function resolveBackground(node: HTMLElement): string {
	for (let el: HTMLElement | null = node; el; el = el.parentElement) {
		const color = getComputedStyle(el).backgroundColor;
		if (color && color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
	}
	return "#ffffff";
}

/**
 * Desenha o nó (com o tema atual) e acrescenta o rodapé "bot · data". Elementos com `data-share-ignore`
 * (o próprio botão de compartilhar) ficam de fora.
 */
export async function renderShareCanvas(node: HTMLElement, options: ShareRenderOptions = {}): Promise<HTMLCanvasElement> {
	const { toCanvas } = await import("html-to-image");
	const now = options.now ?? new Date();
	const ratio = options.pixelRatio ?? 2;
	const body = getComputedStyle(document.body);
	const background = resolveBackground(node);
	const drawn = await toCanvas(node, {
		pixelRatio: ratio,
		backgroundColor: background,
		cacheBust: true,
		filter: (element) => !(element instanceof HTMLElement && element.hasAttribute("data-share-ignore")),
	});
	const footer = Math.round(FOOTER_HEIGHT * ratio);
	const canvas = document.createElement("canvas");
	canvas.width = drawn.width;
	canvas.height = drawn.height + footer;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas indisponível");
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(drawn, 0, 0);
	ctx.fillStyle = body.color || "#666666";
	ctx.globalAlpha = 0.6;
	ctx.font = `${Math.round(12 * ratio)}px ${body.fontFamily || "sans-serif"}`;
	ctx.textBaseline = "middle";
	ctx.textAlign = "right";
	ctx.fillText(shareFooterText(options.botName, now), canvas.width - Math.round(16 * ratio), drawn.height + footer / 2);
	ctx.globalAlpha = 1;
	return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("não consegui gerar a imagem"))), type, quality);
	});
}

export function downloadBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** O navegador sabe copiar imagem para a área de transferência? (Firefox e iOS antigos, não.) */
export function canCopyImage(): boolean {
	return typeof window !== "undefined" && typeof window.ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/** Copia a imagem; sem suporte ou com permissão negada, baixa o PNG. Devolve o que aconteceu. */
export async function copyImageOrDownload(blobPromise: Promise<Blob>, fileName: string): Promise<"copied" | "downloaded"> {
	if (canCopyImage()) {
		try {
			// A promessa entra no ClipboardItem (exigência do Safari: o gesto do usuário vale até a imagem ficar pronta).
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
			return "copied";
		} catch {
			// cai no download
		}
	}
	downloadBlob(await blobPromise, fileName);
	return "downloaded";
}
