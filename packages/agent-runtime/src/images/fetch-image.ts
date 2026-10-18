import { IMAGE_LIMITS, sniffImageType } from "@workspace/shared";
import { Agent } from "undici";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertPublicUrl, isPrivateAddress, type NativeFetchFn, type NativeLookupFn } from "../web-native.js";

export type FetchImageDeps = {
	fetchFn?: NativeFetchFn;
	lookupFn?: NativeLookupFn;
	signal?: AbortSignal;
};

/** Busca uma URL direta de imagem, verificando cada salto antes da requisição. */
export async function fetchImageFromUrl(rawUrl: string, deps: FetchImageDeps = {}): Promise<{ bytes: Buffer; url: string }> {
	const lookupFn = deps.lookupFn ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address));
	// A conexão valida novamente o endereço DNS e o fixa no socket: evita rebinding
	// entre a checagem da URL e o fetch. Cada redirect recebe uma nova validação.
	const dispatcher = new Agent({ connect: { lookup: (hostname, _options, callback) => {
		lookupFn(hostname).then((addresses) => {
			if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
				callback(new Error("URL bloqueada: endereço privado ou DNS inválido."), "", 4);
				return;
			}
			const address = addresses[0]!;
			callback(null, address, isIP(address));
		}, (error: unknown) => callback(error instanceof Error ? error : new Error("DNS inválido."), "", 4));
	} } });
	const fetchFn: NativeFetchFn = deps.fetchFn ?? ((url, init) => fetch(url, { ...init, dispatcher } as RequestInit));
	const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
	let current = rawUrl;
	try {
	for (let redirect = 0; redirect <= 5; redirect++) {
		const url = await assertPublicUrl(current, lookupFn);
		const response = await fetchFn(url.toString(), { method: "GET", redirect: "manual", signal, headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" } });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error("Redirecionamento sem URL de destino.");
			current = new URL(location, url).toString();
			continue;
		}
		if (!response.ok || !response.body) throw new Error(`A imagem não pôde ser baixada (HTTP ${response.status}).`);
		const declared = Number(response.headers.get("content-length"));
		if (declared > IMAGE_LIMITS.maxBytes) throw new Error("Imagem acima de 10 MB.");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > IMAGE_LIMITS.maxBytes) throw new Error("Imagem acima de 10 MB.");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		const bytes = Buffer.concat(chunks);
		if (!sniffImageType(bytes)) throw new Error("A página não devolveu uma imagem válida; passe a URL direta da imagem.");
		return { bytes, url: url.toString() };
	}
	throw new Error("Redirecionamentos demais na URL da imagem.");
	} finally {
		await dispatcher.close();
	}
}
