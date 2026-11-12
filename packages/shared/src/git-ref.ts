// Validação de nome de ref (branch, tag ou SHA) e de `owner/name` antes de virarem caminho de URL da API do GitHub.
// Segue `git check-ref-format` no que importa para segurança de caminho: sem `..`, sem barra no início ou fim, sem
// controle/espaço nem `~ ^ : ? * [ \` e sem `#`. Função pura: decisão de formato, não de texto livre.

const FORBIDDEN_CHARS = new Set([" ", "~", "^", ":", "?", "*", "[", "\\", "#"]);

export function isSafeGitRef(value: string): boolean {
	if (value.length === 0 || value.length > 200) return false;
	if (value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.includes("..") || value.includes("@{")) return false;
	if (value.endsWith(".") || value.endsWith(".lock")) return false;
	for (const ch of value) {
		if (FORBIDDEN_CHARS.has(ch)) return false;
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return value.split("/").every((segment) => segment !== "." && segment !== "" && !segment.startsWith(".") && !segment.startsWith("-"));
}

/** `owner/name` sem segmento `.`/`..` (os dois lados só aceitam letras, números, `_`, `.` e `-`). */
export function isSafeGithubRepo(value: string): boolean {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	return parts.every((part) => part.length >= 1 && part.length <= 100 && part !== "." && part !== ".." && Array.from(part).every((ch) => /[A-Za-z0-9_.-]/.test(ch)));
}
