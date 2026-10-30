import type { MetadataRoute } from "next"

/** App instalável (PWA): necessário para notificações push no iPhone e abre em tela cheia no Android. */
export function webManifest(description: string): MetadataRoute.Manifest {
  return {
    name: "Atlas",
    short_name: "Atlas",
    description,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
