/**
 * Glob determinístico para NOME de tool (identificador): `*` casa qualquer trecho, `?` um
 * caractere. Implementado sem RegExp (não vira superfície de ReDoS) e sem backtracking
 * exponencial (algoritmo guloso de dois ponteiros).
 */
export function globMatch(pattern: string, name: string): boolean {
	let p = 0;
	let n = 0;
	let star = -1;
	let resume = 0;
	while (n < name.length) {
		if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
			p++;
			n++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			resume = n;
		} else if (star >= 0) {
			p = star + 1;
			n = ++resume;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}
