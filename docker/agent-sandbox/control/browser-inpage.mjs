// F8.1 — roda DENTRO da página (Playwright serializa a função: nada de closure externa). Uma função só com várias
// operações, para o mapa, as partes, os textos (busca/arquivo) e a rolagem falarem do MESMO conceito de "seção" e de "item":
//   - seção "list"/"table"/"nav": os filhos de um contêiner que repetem a mesma estrutura (comentários, linhas, cards);
//   - seção "form": os campos de um <form>;
//   - seção "controls": links e botões soltos (têm ref para agir);
//   - seção "text": o texto visível que sobra fora das outras seções, uma linha por item (qualquer marcação).
// Cada seção ganha o atributo `data-atlas-sec="sN"` no elemento; os itens são numerados de 1 em diante na ordem do DOM.
// Campo de senha, de código de uso único e de CARTÃO (card-fields.mjs) NUNCA entram com valor. A interpretação (total declarado, janela) é de browser-map/chunks.
export function atlasInPage({ op, arg, cardSelector }) {
	const SEC = "data-atlas-sec";
	const SIG = "data-atlas-sig";
	const MORE = "data-atlas-more";
	const WIN = "data-atlas-win";
	const REF = "data-atlas-ref";
	const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
	const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}` : value);
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "SVG", "PATH", "CANVAS", "IFRAME"]);
	const isVisible = (el) => {
		if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
		const st = getComputedStyle(el);
		return st.display !== "none" && st.visibility !== "hidden";
	};
	const textOf = (el) => clean(el.innerText != null ? el.innerText : el.textContent);
	const MORE_RE = /\b(load|show|see|view|read|get)\s+(more|all|older|next)\b|\bmore\s+(comments|replies|results|posts|items|reviews)\b|\b(ver|mostrar|carregar|exibir|cargar|voir|charger|mehr)\s+(mais|más|plus|laden|todos|todas|comentários|comentarios|resultados)\b|\bnext page\b|\bpróxima página\b|\bolder (posts|comments)\b/i;
	const sectionEls = () => Array.from(document.querySelectorAll(`[${SEC}]`));
	const secEl = (id) => document.querySelector(`[${SEC}="${id}"]`);
	// Campo de cartão = o mesmo critério do driver do `card_fill` (seletor vindo de card-fields.mjs, passado por quem chama).
	const CARD = cardSelector || 'input[autocomplete^="cc-" i],select[autocomplete^="cc-" i]';
	const isCardField = (el) => {
		try {
			return el.matches(CARD);
		} catch {
			return true;
		}
	};
	const nameOfControl = (el) => {
		const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent || "" : "")).join(" ");
		const labels = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.textContent).join(" ") : "";
		return clean(el.getAttribute("aria-label") || labelled || labels || el.innerText || el.textContent || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("placeholder") || (isSecret(el) ? "" : el.value) || "");
	};
	const sigOf = (c) => `${c.tagName}.${Array.from(c.classList).filter((t) => !/\d/.test(t)).sort().join(".")}.${c.getAttribute("role") || ""}`;
	const isSecret = (el) => {
		const type = (el.getAttribute("type") || "").toLowerCase();
		const hint = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
		if (type === "password") return "password";
		if (isCardField(el)) return "card";
		if ((el.getAttribute("autocomplete") || "").toLowerCase().includes("one-time-code")) return "code";
		if (/(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|sms.?code)([^a-z]|$)/.test(hint)) return "code";
		return "";
	};
	const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch]';

	// Itens de uma seção, na ordem do DOM. Só aqui mora a regra do que é "um item".
	const itemsOf = (el, kind) => {
		if (kind === "table") {
			const rows = Array.from(el.querySelectorAll("tr")).filter((r) => !r.closest("thead") && isVisible(r));
			return rows.map((row) => ({ el: row, text: Array.from(row.children).map((c) => clean(c.innerText || c.textContent)).filter(Boolean).join(" | ") })).filter((i) => i.text);
		}
		if (kind === "form") {
			const fields = Array.from(el.querySelectorAll(INTERACTIVE)).filter(isVisible);
			return fields.map((f) => {
				const tag = f.tagName.toLowerCase();
				const type = (f.getAttribute("type") || "").toLowerCase();
				const secret = isSecret(f);
				let value = "";
				if (secret) value = "(hidden: only the owner fills this)";
				else if (tag === "select") value = clean(f.selectedOptions?.[0]?.textContent);
				else if (tag === "input" || tag === "textarea") value = clean(f.value);
				const kindName = secret ? (secret === "code" ? "one-time code" : secret === "card" ? "card field" : "password") : tag === "input" ? type || "text" : tag;
				const label = nameOfControl(f) || clean(f.getAttribute("name") || f.id);
				return { el: f, text: `${kindName}: ${clip(label, 80)}${value && !secret ? ` = "${clip(value, 120)}"` : secret ? ` ${value}` : ""}` };
			});
		}
		if (kind === "controls") {
			return Array.from(document.querySelectorAll(`[${REF}]`))
				.filter((c) => {
					if (!isVisible(c)) return false;
					const s = c.closest(`[${SEC}]`);
					return !s || s === document.body;
				})
				.map((c) => {
					const tag = c.tagName.toLowerCase();
					const role = c.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? c.getAttribute("type") || "field" : tag);
					const secret = isSecret(c);
					return { el: c, text: `${role}: ${clip(nameOfControl(c), 100) || "(no name)"}${secret ? " (hidden: only the owner fills this)" : ""}` };
				});
		}
		if (kind === "text") {
			// Texto visível fora das outras seções. As outras ficam escondidas um instante: o innerText as ignora (qualquer marcação).
			const hidden = [];
			for (const s of sectionEls()) {
				if (s === document.body || s === document.documentElement) continue;
				hidden.push([s, s.style.display]);
				s.style.setProperty("display", "none", "important");
			}
			let raw = "";
			try {
				raw = document.body.innerText || "";
			} finally {
				for (const [s, display] of hidden) {
					if (display) s.style.display = display;
					else s.style.removeProperty("display");
				}
			}
			return raw.split("\n").map((line) => clean(line)).filter((line) => line.length > 0).map((text) => ({ el: null, text }));
		}
		const sig = el.getAttribute(SIG);
		return Array.from(el.children)
			.filter((c) => !SKIP.has(c.tagName) && (!sig || sigOf(c) === sig) && isVisible(c))
			.map((c) => ({ el: c, text: textOf(c) }))
			.filter((i) => i.text);
	};
	const kindOf = (el) => el.getAttribute("data-atlas-kind") || "list";

	if (op === "map") {
		for (const old of sectionEls()) {
			old.removeAttribute(SEC);
			old.removeAttribute("data-atlas-kind");
			old.removeAttribute(SIG);
		}
		for (const old of document.querySelectorAll(`[${MORE}]`)) old.removeAttribute(MORE);
		const candidates = [];
		let scanned = 0;
		for (const el of document.body.querySelectorAll("*")) {
			if (++scanned > 80000) break;
			if (SKIP.has(el.tagName) || el.children.length < 2) continue;
			if (el.tagName !== "TABLE" && el.closest("table")) continue;
			if (el.closest("form") && el.tagName !== "FORM") continue;
			if (!isVisible(el)) continue;
			const listish = ["UL", "OL", "DL"].includes(el.tagName) || ["list", "feed", "grid", "listbox", "tree"].includes(el.getAttribute("role") || "");
			if (el.tagName === "TABLE") {
				const items = itemsOf(el, "table");
				if (items.length >= 2) candidates.push({ el, kind: "table", items: items.length, chars: items.reduce((n, i) => n + i.text.length, 0), sig: "" });
				continue;
			}
			const counts = new Map();
			let kids = 0;
			for (const c of el.children) {
				if (SKIP.has(c.tagName)) continue;
				kids++;
				const s = sigOf(c);
				counts.set(s, (counts.get(s) || 0) + 1);
			}
			let best = "";
			let bestN = 0;
			for (const [s, n] of counts) if (n > bestN) ((best = s), (bestN = n));
			if (bestN < (listish ? 2 : 4) || bestN < kids * 0.5) continue;
			el.setAttribute(SIG, best);
			const items = itemsOf(el, "list");
			el.removeAttribute(SIG);
			if (items.length < (listish ? 2 : 4)) continue;
			const chars = items.reduce((n, i) => n + i.text.length, 0);
			if (chars < 40) continue;
			const navish = Boolean(el.closest("nav, header, footer, [role=navigation], [role=menu], [role=menubar], [role=banner], [role=contentinfo]"));
			candidates.push({ el, kind: navish ? "nav" : "list", items: items.length, chars, sig: best });
		}
		candidates.sort((a, b) => b.chars - a.chars);
		const chosen = [];
		for (const c of candidates) {
			if (chosen.some((o) => o.el.contains(c.el) || c.el.contains(o.el))) continue;
			chosen.push(c);
		}
		// Formulários que não estão dentro de uma lista escolhida.
		for (const form of document.body.querySelectorAll("form")) {
			if (!isVisible(form) || chosen.some((o) => o.el.contains(form))) continue;
			const n = Array.from(form.querySelectorAll(INTERACTIVE)).filter(isVisible).length;
			if (n > 0) chosen.push({ el: form, kind: "form", items: n, chars: 0, sig: "" });
		}
		const OMIT_AFTER = 60;
		chosen.sort((a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
		const kept = chosen.slice(0, OMIT_AFTER);
		const omitted = chosen.length - kept.length;
		// Ids: s1 é o texto da página; as demais seguem a ordem do DOM; os controles soltos vão por último.
		const out = [];
		const labelFor = (el, kind) => {
			const direct = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
			if (clean(direct)) return { label: clip(clean(direct), 100), hints: [clean(direct)] };
			const cap = el.querySelector && el.querySelector("caption, legend");
			if (cap && clean(cap.textContent)) return { label: clip(clean(cap.textContent), 100), hints: [clean(cap.textContent)] };
			const hints = [];
			let cur = el;
			for (let up = 0; up < 4 && cur && cur !== document.body; up++, cur = cur.parentElement) {
				let sib = cur.previousElementSibling;
				for (let back = 0; sib && back < 3; back++, sib = sib.previousElementSibling) {
					const isHeading = /^H[1-6]$/.test(sib.tagName) || sib.getAttribute("role") === "heading";
					const inner = !isHeading && sib.querySelector ? sib.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]") : null;
					const head = isHeading ? sib : inner;
					if (head && clean(head.textContent)) {
						const text = clean(head.textContent);
						hints.push(text);
						const next = head.nextElementSibling;
						if (next && next !== cur && !next.contains(el)) hints.push(clean(next.textContent).slice(0, 40));
						return { label: clip(text, 100), hints };
					}
				}
			}
			return { label: "", hints };
		};
		let n = 1;
		const secs = [];
		const add = (el, kind, sig, extra) => {
			const id = `s${n++}`;
			el.setAttribute(SEC, id);
			el.setAttribute("data-atlas-kind", kind);
			if (sig) el.setAttribute(SIG, sig);
			secs.push({ id, el, kind, ...extra });
		};
		add(document.body, "text", "", {});
		for (const c of kept) add(c.el, c.kind, c.sig, {});
		add(document.documentElement, "controls", "", {});
		// "controls" mora na raiz: o marcador no <html> não conflita com o <body> (texto).
		for (const s of secs) {
			const kind = s.kind;
			const items = itemsOf(s.el, kind);
			const { label, hints } = s.kind === "text" || s.kind === "controls" ? { label: s.kind === "text" ? "Page text" : "Links and controls outside the lists", hints: [] } : labelFor(s.el, kind);
			const setSize = Number(s.el.getAttribute("aria-rowcount") || (s.el.children[0] && s.el.children[0].getAttribute("aria-setsize")) || "");
			if (Number.isFinite(setSize) && setSize > 0) hints.push(String(setSize));
			let more = false;
			if (s.kind === "list" || s.kind === "table") {
				const scope = (s.el.parentElement && s.el.parentElement.parentElement) || document.body;
				for (const b of scope.querySelectorAll("button,a,[role=button],summary,input[type=button]")) {
					if (!isVisible(b)) continue;
					const inItem = items.some((i) => i.el && i.el.contains(b));
					if (inItem) continue;
					// "Carregar mais" é navegação de LEITURA: controle de formulário (envio) nunca conta, mesmo com o texto certo.
					if (b.closest("form") || b.type === "submit" || b.hasAttribute("formaction")) continue;
					const name = nameOfControl(b);
					if (name.length <= 48 && MORE_RE.test(name)) {
						b.setAttribute(MORE, s.id);
						more = true;
						break;
					}
				}
			}
			const sc = s.el === document.body || s.el === document.documentElement ? document.scrollingElement : s.el;
			const scrollable = s.kind === "list" || s.kind === "table" ? Boolean(sc && sc.scrollHeight > sc.clientHeight + 40 && getComputedStyle(sc).overflowY !== "visible" && s.el !== document.body) : false;
			out.push({
				id: s.id,
				kind: s.kind === "controls" ? "nav" : s.kind,
				label,
				items: items.length,
				countHints: hints.filter(Boolean).slice(0, 4),
				moreControl: more,
				scrollable,
				chars: items.reduce((c, i) => c + i.text.length, 0),
				preview: items[0] ? clip(items[0].text, 80) : "",
			});
		}
		const controls = Array.from(document.querySelectorAll("a[href],button,[role=button],input:not([type=hidden])")).filter(isVisible);
		const unnamed = controls.filter((c) => !nameOfControl(c)).length;
		const canvases = Array.from(document.querySelectorAll("canvas")).reduce((a, c) => a + c.clientWidth * c.clientHeight, 0);
		const bodyChars = clean(document.body.innerText).length;
		const poorTree = (controls.length >= 5 && unnamed / controls.length >= 0.5) || (canvases > 0.4 * innerWidth * innerHeight && bodyChars < 200);
		const captcha = document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile');
		return { url: location.href, title: document.title, omitted, poorTree, wall: captcha && bodyChars < 600 ? "captcha" : undefined, totalChars: bodyChars, sections: out };
	}

	const el = secEl(arg.id);
	if (!el) return { missing: true };
	const kind = kindOf(el);

	if (op === "texts") {
		const cap = arg.itemChars || 20000;
		return { items: itemsOf(el, kind).map((i) => ({ text: i.text.length > cap ? i.text.slice(0, cap) : i.text, chars: i.text.length })) };
	}
	if (op === "window") {
		// Marca os itens [from..to] (1-based) para o coletor de refs e devolve o texto de cada um.
		// `ns` = números pedidos (busca) ou a faixa from..to. Cada item marcado leva o seu índice em `data-atlas-win` (1, 2, ...),
		// porque o coletor de refs só aceita UM elemento como raiz.
		for (const old of document.querySelectorAll(`[${WIN}]`)) old.removeAttribute(WIN);
		const items = itemsOf(el, kind);
		const ns = arg.ns || Array.from({ length: Math.max(0, Math.min(arg.to, items.length) - arg.from + 1) }, (_, i) => arg.from + i);
		const slice = ns.map((n) => items[n - 1]).filter(Boolean);
		slice.forEach((i, k) => {
			if (i.el) i.el.setAttribute(WIN, String(k + 1));
		});
		return { total: items.length, items: slice.map((i) => ({ text: i.text.length > arg.itemChars ? i.text.slice(0, arg.itemChars) : i.text, chars: i.text.length })) };
	}
	if (op === "refs") {
		// Por item da janela marcada: os controles com ref de dentro dele (ou o próprio item, no formulário/controles).
		const all = itemsOf(el, kind);
		const items = (arg.ns || Array.from({ length: Math.max(0, Math.min(arg.to, all.length) - arg.from + 1) }, (_, i) => arg.from + i)).map((n) => all[n - 1]).filter(Boolean);
		return {
			items: items.map((i) => {
				if (!i.el) return [];
				const list = i.el.hasAttribute(REF) ? [i.el] : Array.from(i.el.querySelectorAll(`[${REF}]`));
				return list.filter(isVisible).slice(0, 6).map((c) => ({ ref: c.getAttribute(REF), name: clip(nameOfControl(c) || c.tagName.toLowerCase(), 60) }));
			}),
		};
	}
	if (op === "count") {
		const items = itemsOf(el, kind);
		const sc = el === document.body || el === document.documentElement ? document.scrollingElement : el;
		return { total: items.length, scrollHeight: sc ? sc.scrollHeight : 0 };
	}
	if (op === "scroll") {
		const sc = el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== "visible" && el !== document.body ? el : document.scrollingElement;
		const before = sc.scrollTop;
		sc.scrollTop = sc.scrollHeight;
		// Último item à vista também ajuda listas que carregam por observador de interseção.
		const last = itemsOf(el, kind).at(-1);
		if (last && last.el && last.el.scrollIntoView) last.el.scrollIntoView({ block: "end" });
		return { moved: sc.scrollTop !== before };
	}
	return { error: `unknown op ${op}` };
}
