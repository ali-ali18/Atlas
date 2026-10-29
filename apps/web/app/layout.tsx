import type { Metadata, Viewport } from "next"
import "@workspace/ui/globals.css"

import { Geist, Geist_Mono, Outfit } from "next/font/google"

import { ThemeProvider } from "@/components/theme-provider"
import { BootScreen } from "@/components/boot-screen"
import { ServiceWorkerRegister } from "@/components/providers/service-worker-register"
import { EventHubProvider } from "@/components/providers/event-hub-provider"
import { appViewport } from "@/lib/viewport-config"
import { I18nProvider } from "@/lib/i18n/provider"
import { DEFAULT_UI_LOCALE } from "@/lib/i18n/locales"
import { getUiLocale, getUiMessages } from "@/lib/i18n/server"
import { Toaster } from "@workspace/ui/components/toaster"
import { cn } from "@workspace/ui/lib/utils"

const outfitHeading = Outfit({subsets:['latin'],variable:'--font-heading'});

const geist = Geist({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  applicationName: "Atlas",
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Atlas",
    statusBarStyle: "black-translucent",
    startupImage: [
    { url: "/icons/splash-1170x2532.png", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-1179x2556.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-1284x2778.png", media: "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-1290x2796.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-1125x2436.png", media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-1242x2688.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-828x1792.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
    { url: "/icons/splash-750x1334.png", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
    { url: "/icons/splash-1206x2622.png", media: "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    { url: "/icons/splash-1320x2868.png", media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
    ],
  },
}

export const viewport: Viewport = appViewport

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Idioma por requisição (cookie/Accept-Language): a rota passa a ser dinâmica, ver lib/i18n/README.md.
  const locale = await getUiLocale()
  const messages = locale === DEFAULT_UI_LOCALE ? null : await getUiMessages(locale)
  return (
    <html lang={locale}
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable, outfitHeading.variable)}
    >
      <body>
        <I18nProvider locale={locale} messages={messages}>
          <ThemeProvider>{children}</ThemeProvider>
          <BootScreen />
          <Toaster />
          <ServiceWorkerRegister />
          <EventHubProvider />
        </I18nProvider>
      </body>
    </html>
  )
}
