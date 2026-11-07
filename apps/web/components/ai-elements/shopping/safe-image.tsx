"use client";

import { ImageOffIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@workspace/ui/lib/utils";

/** Só http(s): qualquer outro esquema (javascript:, data:, file:) nunca vira `src` nem `href`. */
export function safeHttpUrl(value: string | undefined | null): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Imagem de fora (foto de loja). O servidor nunca a baixa: o navegador do dono a pede direto, sem enviar o `Referer`
 * (`no-referrer`) e sem cookie. Se falhar ou a URL não for http(s), mostra um espaço neutro do MESMO tamanho: o layout não
 * quebra e o `alt` continua acessível.
 */
export function SafeImage({ src, alt, fallbackLabel, className }: { src: string | undefined; alt: string; fallbackLabel: string; className?: string }) {
	const safe = safeHttpUrl(src);
	const [failed, setFailed] = React.useState(false);
	React.useEffect(() => setFailed(false), [safe]);
	if (!safe || failed) {
		return (
			<span role="img" aria-label={fallbackLabel} data-testid="shopping-image-fallback" className={cn("flex items-center justify-center bg-foreground/[0.06] text-muted-foreground", className)}>
				<ImageOffIcon aria-hidden className="size-4" />
			</span>
		);
	}
	return (
		// eslint-disable-next-line @next/next/no-img-element -- foto de loja externa: não passa pelo otimizador do Next (que a buscaria no servidor)
		<img alt={alt} className={cn("object-cover", className)} decoding="async" loading="lazy" onError={() => setFailed(true)} referrerPolicy="no-referrer" src={safe} />
	);
}
