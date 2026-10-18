import type { Viewport } from "next";

/**
 * Viewport do app (PWA no celular): `resizes-content` faz o teclado encolher o layout (o composer sobe junto,
 * sem ficar escondido) e `cover` deixa o app ocupar a área toda; as bordas usam `env(safe-area-inset-*)`.
 */
export const appViewport: Viewport = {
	themeColor: "#09090b",
	viewportFit: "cover",
	interactiveWidget: "resizes-content",
};
