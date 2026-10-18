// V5 — frames da página. Cada frame (mesmo domínio ou não) ganha um prefixo
// estável `f1`, `f2`… e os refs de elementos dentro dele viram `f1e12`. O
// frame principal não tem prefixo (`e12`). O contador de refs (`seq`) é um só
// para todos os frames, então um ref nunca repete.

export const MAX_FRAMES = 8;

function parse(url) {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

function labelOf(frame) {
	let name = "";
	try {
		name = frame.name();
	} catch {
		// frame desanexado no meio: cai no caminho
	}
	if (name) return name.slice(0, 40);
	const url = parse(frame.url());
	return url && url.pathname && url.pathname !== "/" ? url.pathname.slice(0, 40) : "iframe";
}

export function createFrameRegistry() {
	const ids = new WeakMap();
	const byPrefix = new Map();
	let count = 0;
	let seq = 0;

	function prefixOf(frame) {
		let id = ids.get(frame);
		if (!id) {
			count += 1;
			id = `f${count}`;
			ids.set(frame, id);
		}
		byPrefix.set(id, frame);
		return id;
	}

	/** Frame principal + até MAX_FRAMES iframes vivos (inclui outras origens e aninhados). */
	function list(page) {
		const main = page.mainFrame ? page.mainFrame() : undefined;
		if (!main) return [{ frame: page, prefix: "", label: "", main: true }];
		const mainOrigin = parse(main.url())?.origin ?? "";
		const out = [{ frame: main, prefix: "", label: "", main: true }];
		for (const frame of page.frames()) {
			if (frame === main || out.length > MAX_FRAMES) continue;
			if (frame.isDetached?.()) continue;
			const url = parse(frame.url());
			const inline = !url || url.protocol === "about:";
			const crossOrigin = !inline && url.origin !== mainOrigin ? url.host : "";
			out.push({
				frame,
				prefix: prefixOf(frame),
				label: labelOf(frame),
				main: false,
				...(crossOrigin ? { crossOrigin } : {}),
			});
		}
		return out;
	}

	/** Frame de um ref/prefixo; o principal quando o prefixo é vazio. */
	function frameOf(page, prefix) {
		if (!prefix) return page.mainFrame ? page.mainFrame() : page;
		const frame = byPrefix.get(prefix);
		return frame && !frame.isDetached?.() ? frame : null;
	}

	return {
		list,
		frameOf,
		prefixOf,
		get seq() {
			return seq;
		},
		set seq(value) {
			seq = value;
		},
	};
}

/** `f2e7` -> { prefix: "f2", seq: 7 }; `e7` -> { prefix: "", seq: 7 }. */
export function splitRef(ref) {
	const match = /^(f\d{1,3})?e(\d{1,5})$/.exec(String(ref ?? ""));
	return match ? { prefix: match[1] ?? "", seq: Number(match[2]) } : null;
}

/** Rótulo do frame para as linhas do snapshot/leitura. */
export function frameTag(entry) {
	if (entry.main) return "";
	return entry.crossOrigin ? `${entry.label} other-origin ${entry.crossOrigin}` : entry.label;
}
