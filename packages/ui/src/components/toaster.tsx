"use client"

import { AlertCircleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react"
import { useSyncExternalStore } from "react"

import { cn } from "../lib/utils"
import { toastStore, type ToastItem, type ToastTone } from "../lib/toast-store"

const NO_TOASTS: ToastItem[] = []

const ICONS: Record<ToastTone, typeof InfoIcon> = {
  error: AlertCircleIcon,
  success: CheckCircle2Icon,
  info: InfoIcon,
}

/**
 * Avisos rápidos, neutros. No celular ficam embaixo, acima do composer e da barra de gestos
 * (safe-area); no desktop, no canto inferior. Erros usam `role="alert"`, o resto `role="status"`.
 */
export function Toaster() {
  const items = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, () => NO_TOASTS)
  if (items.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-[100] flex flex-col items-center gap-2 px-4 md:bottom-6"
      data-slot="toaster"
    >
      {items.map((item) => {
        const Icon = ICONS[item.tone]
        return (
          <div
            className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border bg-popover py-2.5 pr-2.5 pl-4 text-popover-foreground text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
            data-slot="toast"
            data-tone={item.tone}
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <Icon aria-hidden className={cn("size-4 shrink-0", item.tone === "error" ? "text-destructive" : "text-muted-foreground")} />
            <p className="min-w-0 flex-1 leading-snug">{item.message}</p>
            {item.actionLabel ? (
              <button
                className="relative shrink-0 rounded-full px-3 py-1.5 font-medium text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring touch-hit"
                onClick={() => {
                  item.onAction?.()
                  toastStore.dismiss(item.id)
                }}
                type="button"
              >
                {item.actionLabel}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
