"use client"

import { cn } from "@workspace/ui/lib/utils"

import { UI_LOCALES, UI_LOCALE_LABELS, type UiLocalePreference } from "@/lib/i18n/locales"
import { nextLocalePreference, writeUiLocalePreference } from "@/lib/i18n/preference"
import { useT, useUiLocalePreference } from "@/lib/i18n/provider"

/**
 * Troca rápida do idioma da interface para telas sem o menu de configurações (login). Grava a escolha do
 * navegador e recarrega, como o seletor de Configurações → Geral. "Automático" desfaz a escolha fixa.
 */
export function UiLocaleSwitcher({ className }: { className?: string }) {
  const t = useT()
  const stored = useUiLocalePreference()
  function choose(preference: UiLocalePreference) {
    const next = nextLocalePreference(preference, stored)
    if (next === null) return
    writeUiLocalePreference(next)
    window.location.reload()
  }
  const options: { value: UiLocalePreference; label: string; lang?: string }[] = [
    ...UI_LOCALES.map((locale) => ({ value: locale, label: UI_LOCALE_LABELS[locale].replace(/\s*\(.*\)$/, ""), lang: locale })),
    { value: "auto", label: t("login.languageAuto") },
  ]
  return (
    <nav aria-label={t("login.language")} className={cn("flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs", className)}>
      {options.map((option) => (
        <button
          aria-current={option.value === stored ? "true" : undefined}
          className={cn(
            "rounded-sm px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
            option.value === stored ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          key={option.value}
          lang={option.lang}
          onClick={() => choose(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </nav>
  )
}
