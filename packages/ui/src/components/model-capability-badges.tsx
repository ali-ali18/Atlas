import { AlertTriangleIcon, EyeIcon, FileTextIcon, WrenchIcon } from "lucide-react"
import { formatContextTokens, type ModelCapabilities } from "@workspace/shared"
import { cn } from "../lib/utils"

type Caps = Pick<ModelCapabilities, "vision" | "pdf" | "tools" | "contextTokens">

const chip =
  "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border/70 px-1.5 text-[10px] font-medium leading-none text-muted-foreground [&>svg]:size-2.5"

/** Selos pequenos das capacidades do modelo: Imagem, PDF, Ferramentas e contexto ("200k"). Só mostra o que o modelo tem. */
export function ModelCapabilityBadges({
  capabilities,
  className,
}: {
  capabilities: Caps
  className?: string
}) {
  const context = formatContextTokens(capabilities.contextTokens)
  if (!capabilities.vision && !capabilities.pdf && !capabilities.tools && !context) return null
  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-1", className)}
      data-slot="model-capability-badges"
    >
      {capabilities.vision ? (
        <span className={chip} title="Lê imagens">
          <EyeIcon aria-hidden />
          Imagem
        </span>
      ) : null}
      {capabilities.pdf ? (
        <span className={chip} title="Lê PDF nativamente">
          <FileTextIcon aria-hidden />
          PDF
        </span>
      ) : null}
      {capabilities.tools ? (
        <span className={chip} title="Usa ferramentas">
          <WrenchIcon aria-hidden />
          Ferramentas
        </span>
      ) : null}
      {context ? (
        <span className={chip} title="Janela de contexto">
          {context}
        </span>
      ) : null}
    </span>
  )
}

/** Aviso discreto quando o modelo escolhido não tem a capacidade que a função exige. */
export function ModelCapabilityWarning({
  message,
  className,
}: {
  message: string | null | undefined
  className?: string
}) {
  if (!message) return null
  return (
    <p
      className={cn("flex items-start gap-1.5 text-xs text-warning", className)}
      data-slot="model-capability-warning"
      role="note"
    >
      <AlertTriangleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>{message}</span>
    </p>
  )
}
