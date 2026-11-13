// Guarda de fórmulas de planilha (auditoria F2, S4): função de rede ou de execução dispara ao abrir o arquivo
// (exfiltra dado da célula, busca URL, roda comando). Lista FIXA e validação de formato; não decide comportamento.

/** Funções de planilha que fazem rede ou executam código. Comparadas em maiúsculas, sem prefixo `_xlfn.`. */
export const DANGEROUS_FORMULA_FUNCTIONS: readonly string[] = [
	"HYPERLINK", "WEBSERVICE", "IMPORTXML", "IMPORTDATA", "IMPORTHTML", "IMPORTRANGE", "IMPORTFEED", "IMAGE",
	"FILTERXML", "CALL", "REGISTER.ID", "REGISTER", "EXEC", "DDE", "DDEAUTO", "RTD",
];

const DANGEROUS = new Set(DANGEROUS_FORMULA_FUNCTIONS);

/** Os nomes proibidos que a fórmula (sem o `=` inicial) usa; vazio quando é uma fórmula comum. */
export function findDangerousFormulaFunctions(formula: string): string[] {
	// Texto entre aspas não é chamada de função: `=IF(A1="HYPERLINK(",1,2)` segue válida.
	const code = formula.replace(/"(?:[^"]|"")*"/g, '""');
	const found = new Set<string>();
	for (const match of code.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
		const name = (match[1] as string).toUpperCase().replace(/^_(XLFN|XLWS)\./, "");
		if (DANGEROUS.has(name)) found.add(name);
	}
	// Invocação DDE: `cmd|' /C calc'!A0`.
	if (/[A-Za-z0-9_.]+\s*\|\s*'/.test(code)) found.add("DDE (app|'topic')");
	return [...found];
}

/** Uma célula de texto que começa com `=` é fórmula (mesma regra do render de `.xlsx`). */
export function isFormulaCell(cell: unknown): cell is string {
	return typeof cell === "string" && cell.length > 1 && cell.startsWith("=");
}
