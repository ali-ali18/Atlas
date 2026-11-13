// Nome das tools de chamada de um conector. Um par por conexão (`mcp_<slug>_read` e `mcp_<slug>_write`): o nome da
// tool de escrita é o que a regra `confirmWrites` casa, e a privacidade (`privateData`) é por conexão.

/** Parte do nome vinda do slug: minúsculas, dígitos e "_". Nunca vazia. */
export function slugPart(slug: string, fallback: string): string {
	// guard-allow: format-validation slug de conexão é identificador, vira parte do nome da tool
	const cleaned = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 40) : fallback;
}

export type ConnectorToolNames = { read: string; write: string };

export function connectorToolNames(part: string): ConnectorToolNames {
	return { read: `mcp_${part}_read`, write: `mcp_${part}_write` };
}

/** Partes únicas, na ordem dada: slug repetido ganha sufixo `_2`, `_3`… para o nome da tool nunca colidir. */
export function uniqueSlugParts(slugs: readonly string[]): string[] {
	const used = new Set<string>();
	return slugs.map((slug, index) => {
		const base = slugPart(slug, `app${index + 1}`);
		let part = base;
		for (let n = 2; used.has(part); n++) part = `${base}_${n}`;
		used.add(part);
		return part;
	});
}
