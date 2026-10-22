import assert from "node:assert/strict";
import test from "node:test";
import {
	LIBRARY_SECTION_DEFAULT_OPEN,
	type LibrarySectionId,
	librarySectionKey,
	pageCardModel,
	readLibrarySectionOpen,
	updatedAgo,
	writeLibrarySectionOpen,
} from "./library-sections";

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	};
}

const broken = {
	getItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

test("padrão: Páginas aberta; Documentos e Rotinas fechadas", () => {
	assert.deepEqual(LIBRARY_SECTION_DEFAULT_OPEN, { pages: true, documents: false, routines: false });
	for (const id of ["pages", "documents", "routines"] as LibrarySectionId[]) {
		assert.equal(readLibrarySectionOpen(id, memoryStorage()), LIBRARY_SECTION_DEFAULT_OPEN[id]);
	}
});

test("cada seção tem a própria chave e lembra o que a pessoa escolheu", () => {
	const storage = memoryStorage();
	assert.notEqual(librarySectionKey("pages"), librarySectionKey("routines"));
	writeLibrarySectionOpen("pages", false, storage);
	writeLibrarySectionOpen("routines", true, storage);
	assert.equal(readLibrarySectionOpen("pages", storage), false);
	assert.equal(readLibrarySectionOpen("routines", storage), true);
	assert.equal(readLibrarySectionOpen("documents", storage), false, "sem escolha, vale o padrão");
	assert.equal(storage.data.get(librarySectionKey("pages")), "0");
});

test("valor guardado inválido cai no padrão", () => {
	const storage = memoryStorage({ [librarySectionKey("pages")]: "talvez", [librarySectionKey("documents")]: "" });
	assert.equal(readLibrarySectionOpen("pages", storage), true);
	assert.equal(readLibrarySectionOpen("documents", storage), false);
});

test("storage que lança (janela privada, dados bloqueados) ou ausente nunca quebra", () => {
	assert.equal(readLibrarySectionOpen("pages", broken), true);
	assert.equal(readLibrarySectionOpen("routines", broken), false);
	assert.doesNotThrow(() => writeLibrarySectionOpen("pages", false, broken));
	assert.equal(readLibrarySectionOpen("pages", null), true);
	assert.doesNotThrow(() => writeLibrarySectionOpen("pages", false, null));
});

const now = new Date("2026-10-26T12:00:00.000Z");
const item = { id: "p1", title: "Vendas", sourceCount: 3, updatedAt: "2026-10-26T10:00:00.000Z", refreshedAt: null as string | null };

test("pageCardModel: título, 'N fontes' e 'Atualizado há X' a partir da edição", () => {
	assert.deepEqual(pageCardModel(item, null, now), { id: "p1", title: "Vendas", sources: "3 fontes", updated: "Atualizado há 2 h", routine: null });
});

test("pageCardModel: com refreshedAt vale ele; 1 fonte no singular; sem fontes some; rotina vai junto", () => {
	const refreshed = pageCardModel({ ...item, sourceCount: 1, refreshedAt: "2026-10-26T11:58:00.000Z" }, "Toda segunda às 08:00", now);
	assert.equal(refreshed.sources, "1 fonte");
	assert.equal(refreshed.updated, "Atualizado há 2 min");
	assert.equal(refreshed.routine, "Toda segunda às 08:00");
	assert.equal(pageCardModel({ ...item, sourceCount: 0 }, null, now).sources, null);
});

test("updatedAgo: agora, ontem e data inválida", () => {
	assert.equal(updatedAgo("2026-10-26T11:59:40.000Z", now), "Atualizado agora");
	assert.equal(updatedAgo("2026-10-25T09:00:00.000Z", now), "Atualizado ontem");
	assert.equal(updatedAgo(null, now), null);
	assert.equal(updatedAgo("não é data", now), null);
});
