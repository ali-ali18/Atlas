// V5 — frames da página. Cada frame (mesmo domínio ou não) ganha um prefixo
// estável `f1`, `f2`… e os refs de elementos dentro dele viram `f1e12`. O
// frame principal não tem prefixo (`e12`). O contador de refs (`seq`) é um só
// para todos os frames da aba, então um ref nunca repete nela.

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

// O estado é POR ABA (página): `f1` de uma aba nunca resolve para o frame de outra, e o contador de
// refs de uma aba não mexe no da outra (subagentes trabalham em abas paralelas).
export function createFrameRegistry() {
	const states = new WeakMap();
	const stateOf = (page) => {
		let state = states.get(page);
		if (!state) {
			state = { ids: new WeakMap(), byPrefix: new Map(), count: 0, seq: 0, omitted: 0 };
			states.set(page, state);
		}
		return state;
	};

	function prefixOf(page, frame) {
		const state = stateOf(page);
		let id = state.ids.get(frame);
		if (!id) {
			state.count += 1;
			id = `f${state.count}`;
			state.ids.set(frame, id);
		}
		state.byPrefix.set(id, frame);
		return id;
	}

	/** Frame principal + até MAX_FRAMES iframes vivos (inclui outras origens e aninhados). */
	function list(page) {
		const main = page.mainFrame ? page.mainFrame() : undefined;
		if (!main) return [{ frame: page, prefix: "", label: "", main: true }];
		const mainOrigin = parse(main.url())?.origin ?? "";
		const out = [{ frame: main, prefix: "", label: "", main: true }];
		let omitted = 0;
		for (const frame of page.frames()) {
			if (frame === main) continue;
			if (frame.isDetached?.()) continue;
			if (out.length > MAX_FRAMES) {
				omitted += 1;
				continue;
			}
			const url = parse(frame.url());
			const inline = !url || url.protocol === "about:";
			const crossOrigin = !inline && url.origin !== mainOrigin ? url.host : "";
			out.push({
				frame,
				prefix: prefixOf(page, frame),
				label: labelOf(frame),
				main: false,
				...(crossOrigin ? { crossOrigin } : {}),
			});
		}
		stateOf(page).omitted = omitted;
		return out;
	}

	/** Frame de um ref/prefixo NA aba `page`; o principal quando o prefixo é vazio. */
	function frameOf(page, prefix) {
		if (!prefix) return page.mainFrame ? page.mainFrame() : page;
		const frame = states.get(page)?.byPrefix.get(prefix);
		return frame && !frame.isDetached?.() ? frame : null;
	}

	return {
		list,
		frameOf,
		prefixOf,
		/** Quantos iframes vivos ficaram de fora da última listagem (teto MAX_FRAMES). */
		omittedOf: (page) => stateOf(page).omitted,
		seqOf: (page) => stateOf(page).seq,
		setSeq: (page, value) => {
			stateOf(page).seq = value;
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
