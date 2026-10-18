"use client"
import { useEffect, useState, type ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@workspace/ui/components/dialog"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@workspace/ui/components/sheet"

const DESKTOP_MIN = 768

/** Tela de computador (md+)? Valor inicial já certo no cliente para a folha não piscar como modal no celular. */
function useDesktop() {
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.innerWidth >= DESKTOP_MIN)
  useEffect(() => {
    const update = () => setDesktop(window.innerWidth >= DESKTOP_MIN)
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [])
  return desktop
}

/**
 * Contêiner do fluxo "Conectar API": folha de baixo no celular; modal centralizado
 * (largura ~480px) em telas largas. O conteúdo dos passos é o mesmo nos dois.
 */
export function FlowPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
}) {
  const desktop = useDesktop()
  if (desktop) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent
          className="max-h-[90dvh] w-full gap-0 overflow-y-auto rounded-3xl p-0 pb-4 sm:max-w-[480px]"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          {children}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-3xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        showCloseButton={false}
        side="bottom"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  )
}
