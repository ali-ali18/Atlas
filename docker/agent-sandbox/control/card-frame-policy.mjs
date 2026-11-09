// Onde o `card_fill` pode DIGITAR o cartão. O número só entra (a) na página principal da loja aprovada, (b) num iframe da MESMA
// origem registrável da loja ou (c) num iframe de um gateway de pagamento conhecido (lista curta abaixo, sem nada específico de
// uma loja). Qualquer outro iframe (anúncio, widget de terceiro, página que a loja não controla) nunca recebe o cartão.
// Sempre https: um iframe em http: não é aceito (o dado trafegaria em claro).

/** Gateways que hospedam os campos de cartão em iframe (provedor de pagamento, não loja). Casa o domínio e seus subdomínios. */
export const KNOWN_GATEWAY_DOMAINS = [
	"stripe.com",
	"stripe.network",
	"adyen.com",
	"braintreegateway.com",
	"braintree-api.com",
	"paypal.com",
	"paypalobjects.com",
	"checkout.com",
	"squareup.com",
	"squarecdn.com",
	"authorize.net",
	"cybersource.com",
	"worldpay.com",
	"mercadopago.com",
	"mercadopago.com.br",
	"mercadolibre.com",
	"pagar.me",
	"pagseguro.uol.com.br",
	"pagbank.com.br",
	"ebanx.com",
	"iugu.com",
	"vindi.com.br",
	"cielo.com.br",
	"getnet.com.br",
	"recurly.com",
];

// Sufixos de dois níveis mais comuns (`com.br`, `co.uk`...). Sem a lista pública completa de sufixos: na dúvida o domínio
// registrável fica MAIOR (3 rótulos), o que só deixa a regra mais estrita.
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "ne", "or"]);

/** Domínio registrável aproximado (`js.stripe.com` -> `stripe.com`, `loja.com.br` -> `loja.com.br`). `null` se não for um host. */
export function registrableDomain(host) {
	const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!name || /[^a-z0-9.-]/.test(name)) return null;
	const labels = name.split(".").filter(Boolean);
	if (labels.length < 2) return null;
	if (/^\d+$/.test(labels.at(-1))) return null; // IP literal
	const twoLevel = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2));
	return labels.slice(twoLevel ? -3 : -2).join(".");
}

const hostOf = (url) => {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
};

export const isHttps = (url) => hostOf(url) !== null;

const isKnownGateway = (host) => KNOWN_GATEWAY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** O iframe `frameUrl` pode receber o cartão de quem está pagando em `storeUrl`? */
export function isTrustedCardFrame(frameUrl, storeUrl) {
	const host = hostOf(frameUrl);
	if (!host) return false;
	const store = registrableDomain(hostOf(storeUrl));
	const own = registrableDomain(host);
	if (store && own && store === own) return true;
	return isKnownGateway(host);
}
