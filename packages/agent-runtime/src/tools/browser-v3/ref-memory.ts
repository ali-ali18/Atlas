/**
 * Memória do último snapshot da árvore, por sessão da VM: quais refs são campo de senha ou de código de uso único.
 * Fail-closed: `browser_act` recusa digitar nesses refs (o caminho é `login_fill` ou o cartão de login). O servidor
 * já omite o valor desses campos; aqui o modelo também não consegue inventar uma senha.
 */
const SECRET_MARK = /\(campo de (?:senha|código de uso único)/;
const REF = /\[((?:f\d{1,3})?[ea]\d{1,5})\]/;
const MAX_SESSIONS = 100;

const secretsBySession = new Map<string, Set<string>>();

/** Substitui a memória da sessão pelo que o snapshot atual mostra (linhas da árvore e/ou da lista). */
export function rememberSecretRefs(sessionId: string, lines: readonly string[]): void {
	const secret = new Set<string>();
	for (const line of lines) {
		if (!SECRET_MARK.test(line)) continue;
		const ref = REF.exec(line)?.[1];
		if (ref) secret.add(ref);
	}
	if (secretsBySession.size >= MAX_SESSIONS && !secretsBySession.has(sessionId)) {
		const oldest = secretsBySession.keys().next().value;
		if (oldest !== undefined) secretsBySession.delete(oldest);
	}
	secretsBySession.set(sessionId, secret);
}

export function isSecretRef(sessionId: string, ref: string): boolean {
	return secretsBySession.get(sessionId)?.has(ref) === true;
}

/** Depois de navegar os refs antigos morreram. */
export function forgetRefs(sessionId: string): void {
	secretsBySession.delete(sessionId);
}
