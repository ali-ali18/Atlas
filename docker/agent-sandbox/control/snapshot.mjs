// F12/B1 — interpretação pura dos fatos brutos de `collectInteractive`.

export const SNAPSHOT_DEFAULT_LIMIT = 80;
export const SNAPSHOT_MAX_LIMIT = 80;
export const SNAPSHOT_MAX_SCAN = 400;

const INPUT_ROLES = {
	checkbox: "checkbox",
	radio: "radio",
	button: "button",
	submit: "button",
	reset: "button",
	image: "button",
	range: "slider",
	number: "spinbutton",
	search: "searchbox",
	file: "file-input",
};

export function clampSnapshotPage({ offset, limit } = {}) {
	const off = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
	const lim =
		Number.isFinite(Number(limit)) && Number(limit) > 0
			? Math.min(SNAPSHOT_MAX_LIMIT, Math.floor(Number(limit)))
			: SNAPSHOT_DEFAULT_LIMIT;
	return { offset: off, limit: lim };
}

export function roleOf(raw) {
	if (raw.roleAttr) return raw.roleAttr;
	switch (raw.tag) {
		case "a":
			return "link";
		case "button":
		case "summary":
			return "button";
		case "select":
			return "combobox";
		case "textarea":
			return "textbox";
		case "input":
			if (raw.autocomplete && !INPUT_ROLES[raw.type]) return "combobox";
			return INPUT_ROLES[raw.type] ?? "textbox";
		default:
			return raw.editable ? "textbox" : "clickable";
	}
}

/** aria-label > aria-labelledby > <label> > texto > placeholder > title/alt > name. */
export function nameOf(raw) {
	const isTextControl = raw.tag === "input" || raw.tag === "textarea" || raw.tag === "select";
	const isButtonInput =
		raw.tag === "input" && (raw.type === "button" || raw.type === "submit" || raw.type === "reset");
	const candidates = [
		raw.ariaLabel,
		raw.labelledBy,
		raw.label,
		isTextControl ? "" : raw.text,
		isButtonInput ? raw.value : "",
		raw.placeholder,
		raw.title,
		raw.alt,
		raw.nameAttr,
	];
	const name = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
	return (name ?? "").trim().slice(0, 80);
}

export function describeElement(raw) {
	const role = roleOf(raw);
	const element = { ref: raw.ref, role, name: nameOf(raw) };
	const isValueRole =
		role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton" || role === "slider";
	if (raw.secret) element.secret = true;
	if (isValueRole && !raw.secret && typeof raw.value === "string") element.value = raw.value;
	if (raw.checked !== undefined) element.checked = raw.checked;
	if (raw.disabled) element.disabled = true;
	if (raw.readOnly) element.readOnly = true;
	if (raw.required) element.required = true;
	if (raw.expanded !== undefined) element.expanded = raw.expanded;
	if (raw.autocomplete) element.autocomplete = true;
	if (raw.href) element.href = raw.href;
	if (raw.options) {
		element.options = raw.options.map((option) => option.label || option.value);
		if (raw.optionCount > raw.options.length) element.moreOptions = raw.optionCount - raw.options.length;
	}
	if (raw.landmark) element.landmark = raw.landmark;
	if (raw.inFrame) element.frame = raw.inFrame;
	if (raw.inViewport === false) element.offscreen = true;
	return element;
}

const q = (value) => JSON.stringify(String(value));

/** Uma linha compacta por elemento: `[e3] textbox "Cliente" value="x" required`. */
export function formatElementLine(element) {
	const parts = [`[${element.ref}] ${element.role}`];
	if (element.name) parts.push(q(element.name));
	if (element.secret) parts.push("(campo de senha: nunca preencha)");
	if (element.value !== undefined && element.value !== "") parts.push(`value=${q(element.value)}`);
	if (element.options) {
		const more = element.moreOptions ? `|+${element.moreOptions}` : "";
		parts.push(`options=[${element.options.join("|")}${more}]`);
	}
	if (element.checked !== undefined) parts.push(element.checked ? "checked" : "unchecked");
	if (element.expanded !== undefined) parts.push(element.expanded ? "expanded" : "collapsed");
	if (element.autocomplete) parts.push("autocomplete");
	if (element.required) parts.push("required");
	if (element.readOnly) parts.push("readonly");
	if (element.disabled) parts.push("disabled");
	if (element.href) parts.push(`→ ${element.href}`);
	if (element.landmark) parts.push(`(${element.landmark})`);
	if (element.frame) parts.push(`{iframe ${element.frame}}`);
	if (element.offscreen) parts.push("↓fora da janela");
	return parts.join(" ");
}

/** Monta a resposta paginada do snapshot a partir dos brutos já ordenados. */
export function buildSnapshot({ url, title, raws, page, scroll }) {
	const { offset, limit } = clampSnapshotPage(page);
	const slice = raws.slice(offset, offset + limit);
	const elements = slice.map(describeElement);
	const end = offset + slice.length;
	const hasMore = end < raws.length;
	return {
		url,
		title,
		total: raws.length,
		offset,
		limit,
		nextOffset: hasMore ? end : null,
		...(scroll ?? {}),
		elements,
		lines: elements.map(formatElementLine),
	};
}
