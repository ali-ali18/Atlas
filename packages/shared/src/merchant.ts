/**
 * Loja pelo domínio (Motor v4, F6.3 e F6.4). Uma função só para os dois lados da compra: o mandato grava a loja assim e o
 * `checkout` compara com a loja da URL de pagamento do mesmo jeito. Função pura (sem I/O).
 * Forma canônica: host em minúsculo, sem `www.`, sem ponto final, em punycode (`new URL` converte nome acentuado).
 */
const LABEL_MAX = 63;
const HOST_MAX = 253;

/** Rótulo de domínio já em ASCII: letras, dígitos e hífen no meio. Formato determinístico (não é decisão de comportamento). */
const isDomainLabel = (label: string): boolean => label.length > 0 && label.length <= LABEL_MAX && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);

/** Domínio de loja válido: pelo menos dois rótulos, TLD com letra (nada de IP nem `localhost`). */
export function isStoreHost(host: string): boolean {
	if (host.length === 0 || host.length > HOST_MAX) return false;
	const labels = host.split(".");
	if (labels.length < 2 || !labels.every(isDomainLabel)) return false;
	return /[a-z]/.test(labels[labels.length - 1] ?? "");
}

/**
 * Domínio canônico da loja a partir de um domínio ou de uma URL (`https://loja.com/x`, `www.Loja.com/`, `lojá.com.br`).
 * `null` se não for um domínio válido: IP, `localhost`, texto solto, protocolo que não é http(s) ou credenciais na URL.
 */
export function normalizeMerchant(input: string): string | null {
	const text = input.trim();
	if (text.length === 0 || text.length > 2000 || /\s/.test(text)) return null;
	try {
		const url = new URL(text.includes("://") ? text : `https://${text}`);
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
		let host = url.hostname.toLowerCase();
		if (host.endsWith(".")) host = host.slice(0, -1);
		if (host.startsWith("www.")) host = host.slice(4);
		return isStoreHost(host) ? host : null;
	} catch {
		return null;
	}
}
