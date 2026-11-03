// Motor v2 — nome das refs da árvore de acessibilidade para o modelo.
//
// O Playwright numera `aria-ref` como `eN` / `fNeN`, o mesmo formato do
// `data-atlas-ref` do DOM (v1, marcas de screenshot, read/find). Com o mesmo
// formato, a resolução dependia do último motor da aba e uma ref lida numa
// árvore podia cair em OUTRO elemento. Aqui a ref da árvore ganha letra própria
// (`aN` / `fNaN`): o formato diz de qual motor ela veio, sem estado.

const ARIA_REF = /^(f\d{1,3})?e(\d{1,5})$/;
const TREE_REF = /^(f\d{1,3})?a(\d{1,5})$/;

/** `e12` / `f1e12` (Playwright) -> `a12` / `f1a12` (o que o modelo vê). Outro formato passa igual. */
export function toTreeRef(ariaRef) {
	const m = ARIA_REF.exec(String(ariaRef ?? ""));
	return m ? `${m[1] ?? ""}a${m[2]}` : String(ariaRef ?? "");
}

/** `a12` / `f1a12` -> `e12` / `f1e12`, o que o Playwright entende em `aria-ref=`. */
export function toAriaRef(treeRef) {
	const m = TREE_REF.exec(String(treeRef ?? ""));
	return m ? `${m[1] ?? ""}e${m[2]}` : String(treeRef ?? "");
}

export const isTreeRef = (ref) => TREE_REF.test(String(ref ?? ""));
