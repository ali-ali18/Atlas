/**
 * Opções de /screenshot: `?scalePct=80&quality=70` devolve JPEG reduzido
 * (formato do modelo); sem query, PNG integral (UI/viewer). scrot gera a
 * miniatura sozinho (`-t PCT`), sem ImageMagick na imagem.
 */
export function parseScreenshotOptions(url) {
	const query = new URL(url, "http://localhost").searchParams;
	const scale = Number.parseInt(query.get("scalePct") ?? "", 10);
	const quality = Number.parseInt(query.get("quality") ?? "", 10);
	const region = parseRegion(query.get("region"));
	const marks = query.get("marks") === "1";
	const wantsJpeg = Number.isFinite(scale) || Number.isFinite(quality) || Boolean(region);
	if (!wantsJpeg) return { jpeg: false, marks };
	return {
		jpeg: true,
		marks,
		region,
		scalePct: Number.isFinite(scale) ? Math.min(100, Math.max(10, scale)) : 100,
		quality: Number.isFinite(quality) ? Math.min(95, Math.max(30, quality)) : 70,
	};
}

/**
 * `region=x,y,w,h` em pixels da TELA real (recorte para zoom). Inválido ou
 * minúsculo → ignorado (screenshot inteira) em vez de falhar.
 */
export function parseRegion(raw) {
	if (!raw) return undefined;
	const parts = raw.split(",").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
	const [x, y, w, h] = parts;
	if (x < 0 || y < 0 || w < 8 || h < 8 || w > 8192 || h > 8192) return undefined;
	return { x, y, w, h };
}

/** Argumentos do scrot e nome do arquivo a ler, dado o caminho-base (sem extensão). */
export function scrotPlan(base, options) {
	if (!options.jpeg) {
		return { args: ["--overwrite", `${base}.png`], read: `${base}.png`, cleanup: [`${base}.png`] };
	}
	const args = ["--overwrite", "-q", String(options.quality)];
	if (options.region) {
		const { x, y, w, h } = options.region;
		args.push("-a", `${x},${y},${w},${h}`);
	}
	if (options.scalePct < 100) args.push("-t", String(options.scalePct));
	args.push(`${base}.jpg`);
	const full = `${base}.jpg`;
	const thumb = `${base}-thumb.jpg`;
	return {
		args,
		read: options.scalePct < 100 ? thumb : full,
		cleanup: [full, thumb],
	};
}
