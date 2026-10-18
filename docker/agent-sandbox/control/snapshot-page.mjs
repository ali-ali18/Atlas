// F12/B1 — roda DENTRO da página (Playwright serializa a função): lista os
// elementos interativos visíveis, grava `data-atlas-ref` e devolve fatos
// brutos. Nada de closure externa aqui. A interpretação (role/nome/linha)
// fica em snapshot.mjs, que é puro e testável.

export const REF_ATTR = "data-atlas-ref";

export function collectInteractive(options) {
	const { scope, start, mode, area, maxScan } = options;
	const prefix = options.prefix || "";
	// mode "refs": só descreve elementos que JÁ têm ref (os que reapareceram); não numera.
	const only = mode === "refs" ? new Set(options.only || []) : null;
	const attr = "data-atlas-ref";
	const root = scope ? document.querySelector(scope) : document;
	if (!root) return { raw: [], seq: start, missingScope: true };

	// Shadow roots abertos: querySelectorAll não atravessa, então junta os roots.
	const roots = [root];
	if (root.querySelectorAll) {
		for (let i = 0; i < roots.length && roots.length < 200; i += 1) {
			for (const host of roots[i].querySelectorAll("*")) if (host.shadowRoot) roots.push(host.shadowRoot);
		}
	}
	const deepAll = (selector) => roots.flatMap((r) => Array.from(r.querySelectorAll(selector)));

	if (mode === "full") {
		for (const el of deepAll(`[${attr}]`)) el.removeAttribute(attr);
	}

	const selector = [
		"a[href]",
		"button",
		"input:not([type=hidden])",
		"select",
		"textarea",
		"summary",
		"[contenteditable=''], [contenteditable='true']",
		"[onclick]",
		"[tabindex]:not([tabindex='-1'])",
		"[role=button], [role=link], [role=textbox], [role=searchbox], [role=checkbox], [role=radio]",
		"[role=combobox], [role=listbox], [role=option], [role=menuitem], [role=tab], [role=switch]",
		"[role=menuitemcheckbox], [role=menuitemradio], [role=treeitem], [role=slider], [role=spinbutton]",
	].join(",");

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const clip = (value, max) => {
		const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	};
	const visible = (el, rect) => {
		if (rect.width < 1 || rect.height < 1) return false;
		const style = getComputedStyle(el);
		return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	};
	const textById = (ids) =>
		String(ids || "")
			.split(/\s+/)
			.map((id) => (id ? document.getElementById(id)?.textContent || "" : ""))
			.join(" ");
	const labelOf = (el) => {
		if (el.labels && el.labels.length > 0) {
			return Array.from(el.labels).map((label) => label.textContent || "").join(" ");
		}
		const wrapping = el.closest && el.closest("label");
		return wrapping ? wrapping.textContent || "" : "";
	};
	const landmarkOf = (el) => {
		const host = el.closest("form, nav, header, footer, aside, main, dialog, [role=dialog], [role=navigation], [role=main]");
		if (!host) return "";
		return host.getAttribute("role") || host.tagName.toLowerCase();
	};

	const raw = [];
	let seq = start;
	for (const el of (root.querySelectorAll ? deepAll(selector) : [])) {
		if (raw.length >= maxScan) break;
		const existing = el.getAttribute(attr);
		if (mode === "incremental" && existing) continue;
		const keep = mode === "all" && existing;
		if (only && !only.has(existing)) continue;
		const rect = el.getBoundingClientRect();
		if (!visible(el, rect)) continue;
		const inViewport = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
		if (!only && area === "viewport" && !inViewport) continue;

		let ref = existing;
		if (!only && !keep) {
			seq += 1;
			ref = `${prefix}e${seq}`;
			el.setAttribute(attr, ref);
		}

		const tag = el.tagName.toLowerCase();
		const type = (el.getAttribute("type") || "").toLowerCase();
		const isPassword = tag === "input" && type === "password";
		const isField = tag === "input" || tag === "textarea" || tag === "select";
		let value;
		if (isPassword) value = undefined;
		else if (tag === "select") value = el.selectedOptions?.[0]?.textContent;
		else if (isField) value = el.value;
		else if (el.isContentEditable) value = el.textContent;

		raw.push({
			ref,
			tag,
			type,
			roleAttr: el.getAttribute("role") || "",
			ariaLabel: clip(el.getAttribute("aria-label"), 100),
			labelledBy: clip(textById(el.getAttribute("aria-labelledby")), 100),
			label: clip(labelOf(el), 100),
			text: clip(el.innerText || el.textContent || "", 100),
			placeholder: clip(el.getAttribute("placeholder"), 80),
			title: clip(el.getAttribute("title"), 80),
			alt: clip(el.getAttribute("alt"), 80),
			nameAttr: clip(el.getAttribute("name") || el.id, 60),
			value: value === undefined ? undefined : clip(value, 120),
			secret: isPassword,
			checked:
				typeof el.checked === "boolean" && (type === "checkbox" || type === "radio")
					? el.checked
					: el.getAttribute("aria-checked") === "true"
						? true
						: undefined,
			disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
			readOnly: Boolean(el.readOnly),
			required: Boolean(el.required) || el.getAttribute("aria-required") === "true",
			expanded: el.hasAttribute("aria-expanded")
				? el.getAttribute("aria-expanded") === "true"
				: tag === "summary" && el.parentElement?.tagName === "DETAILS"
					? el.parentElement.open
					: undefined,
			// Sinais estruturais para decidir se é um controle de expandir (V5).
			popup: el.getAttribute("aria-haspopup") || undefined,
			// Envio estrutural (V6): <button> sem type dentro de <form> já envia; `type` acima é só o atributo.
			submits: (tag === "button" || tag === "input") && Boolean(el.form) && el.type === "submit",
			// Form que escreve (action ou POST) e o controle sem aria-controls: não é um disclosure.
			inWriteForm: (() => {
				const form = el.closest("form");
				return Boolean(form && (form.getAttribute("action") || (form.getAttribute("method") || "").toLowerCase() === "post"));
			})(),
			controls: Boolean(el.getAttribute("aria-controls")),
			inMenu: Boolean(el.closest("nav, [role=navigation], [role=menubar], [role=menu], [role=listbox]")),
			selected: el.getAttribute("aria-selected") || undefined,
			autocomplete:
				Boolean(el.getAttribute("list")) ||
				el.getAttribute("aria-autocomplete") === "list" ||
				el.getAttribute("role") === "combobox",
			href: tag === "a" ? clip(el.getAttribute("href"), 120) : undefined,
			editable: Boolean(el.isContentEditable),
			options:
				tag === "select"
					? Array.from(el.options).slice(0, 15).map((option) => ({
							label: clip(option.textContent, 60),
							value: clip(option.value, 60),
							selected: option.selected,
						}))
					: undefined,
			optionCount: tag === "select" ? el.options.length : undefined,
			landmark: landmarkOf(el),
			inViewport,
			box: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
		});
	}
	return { raw, seq };
}
