"use client"

import { cn } from "@workspace/ui/lib/utils"

import { UI_LOCALES, UI_LOCALE_LABELS, type UiLocalePreference } from "@/lib/i18n/locales"
import { writeUiLocalePreference } from "@/lib/i18n/preference"
import { useLocale, useT } from "@/lib/i18n/provider"

/**
 * Troca rápida do idioma da interface para telas sem o menu de configurações (login). Grava a escolha do
 * navegador e recarrega, como o seletor de Configurações → Geral.
 */
export function UiLocaleSwitcher({ className }: { className?: string }) {
  const t = useT()
  const current = useLocale()
  function choose(preference: UiLocalePreference) {
    if (preference === current) return
    writeUiLocalePreference(preference)
    window.location.reload()
  }
  return (
    <nav aria-label={t("login.language")} className={cn("flex items-center justify-center gap-3 text-xs", className)}>
      {UI_LOCALES.map((locale) => (
        <button
          aria-current={locale === current ? "true" : undefined}
          className={cn(
            "rounded-sm px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
            locale === current ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          key={locale}
          lang={locale}
          onClick={() => choose(locale)}
          type="button"
        >
          {UI_LOCALE_LABELS[locale].replace(/\s*\(.*\)$/, "")}
        </button>
      ))}
    </nav>
  )
}
