import assert from "node:assert/strict";
import test from "node:test";
import {
	COMPOSIO_FIRST_PAGE,
	composioHasPrev,
	composioNextPage,
	composioPageCursor,
	composioPageLabel,
	composioPageNumber,
	composioPagerForFilter,
	composioPrevPage,
} from "./composio-state";

const same = { search: "", category: "" };

test("paginação por cursor: avançar guarda o cursor e voltar reaproveita os anteriores", () => {
	let pager = COMPOSIO_FIRST_PAGE;
	assert.equal(composioPageNumber(pager), 1);
	assert.equal(composioPageCursor(pager), null);
	assert.equal(composioHasPrev(pager), false);

	pager = composioNextPage(pager, "c2");
	assert.equal(composioPageNumber(pager), 2);
	assert.equal(composioPageCursor(pager), "c2");
	pager = composioNextPage(pager, "c3");
	assert.equal(composioPageCursor(pager), "c3");
	assert.equal(composioHasPrev(pager), true);

	pager = composioPrevPage(pager);
	assert.equal(composioPageNumber(pager), 2);
	assert.equal(composioPageCursor(pager), "c2");
	pager = composioPrevPage(composioPrevPage(pager));
	assert.equal(composioPageNumber(pager), 1);
	assert.equal(composioPageCursor(pager), null);
});

test("sem nextCursor (última página) não avança; Anterior na primeira não faz nada", () => {
	assert.equal(composioNextPage(COMPOSIO_FIRST_PAGE, null), COMPOSIO_FIRST_PAGE);
	assert.equal(composioPrevPage(COMPOSIO_FIRST_PAGE), COMPOSIO_FIRST_PAGE);
});

test("avançar depois de voltar descarta cursores velhos à frente", () => {
	let pager = composioNextPage(composioNextPage(COMPOSIO_FIRST_PAGE, "c2"), "c3");
	pager = composioPrevPage(pager);
	pager = composioNextPage(pager, "novo");
	assert.deepEqual(pager.cursors, [null, "c2", "novo"]);
	assert.equal(pager.index, 2);
});

test("buscar ou trocar a categoria volta para a página 1; o mesmo filtro mantém a página", () => {
	const page3 = composioNextPage(composioNextPage(COMPOSIO_FIRST_PAGE, "c2"), "c3");
	assert.equal(composioPagerForFilter(page3, same, { ...same, search: "git" }), COMPOSIO_FIRST_PAGE);
	assert.equal(composioPagerForFilter(page3, same, { ...same, category: "crm" }), COMPOSIO_FIRST_PAGE);
	assert.equal(composioPagerForFilter(page3, same, { ...same }), page3);
});

test("rótulo da página: com total mostra 'de M', sem total só 'Página N'", () => {
	const page2 = composioNextPage(COMPOSIO_FIRST_PAGE, "c2");
	assert.equal(composioPageLabel(page2, 100, 24), "Página 2 de 5");
	assert.equal(composioPageLabel(COMPOSIO_FIRST_PAGE, 24, 24), "Página 1 de 1");
	assert.equal(composioPageLabel(page2, null, 24), "Página 2");
	assert.equal(composioPageLabel(page2, 10, 24), "Página 2 de 2");
});
