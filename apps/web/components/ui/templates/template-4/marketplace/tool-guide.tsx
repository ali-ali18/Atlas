"use client"

import { isReadOnlyMcpTool, type ApiOperation, type McpToolInfo } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { FlowPanel } from "@/components/ai-elements/login/flow-panel"
import { useTranslations } from "@/lib/i18n/provider"
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator"

export type GuideParam = {
  name: string
  /** Tipo em português ("texto", "número", "lista de texto"...). */
  type: string
  required: boolean
  description?: string
  /** Onde o parâmetro vai (API): "caminho" ou "consulta". */
  place?: string
}

/** O que o guia mostra de uma ferramenta (MCP) ou de uma operação (API). */
export type ToolGuideData = {
  title: string
  /** Nome técnico (mono): tool MCP ou `GET /caminho`. */
  code: string
  /** Etiqueta de acesso: "Leitura", "Escrita"... */
  access: string
  accessTone: "read" | "write" | "neutral"
  description?: string
  params: GuideParam[]
  /** Aviso no fim (ex.: só leitura liberada). */
  note?: string
  method?: string
}

const TYPE_KEYS = {
  string: "marketplace.toolGuide.type.string",
  number: "marketplace.toolGuide.type.number",
  integer: "marketplace.toolGuide.type.integer",
  boolean: "marketplace.toolGuide.type.boolean",
  object: "marketplace.toolGuide.type.object",
  array: "marketplace.toolGuide.type.array",
  null: "marketplace.toolGuide.type.null",
} as const satisfies Record<string, MessageKey>

const typeLabel = (type: string, { t }: Translator) => (Object.hasOwn(TYPE_KEYS, type) ? t(TYPE_KEYS[type as keyof typeof TYPE_KEYS]) : type)

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Tipo legível de um trecho de JSON Schema ("texto", "lista de número", "uma de: a, b"). */
export function schemaTypeLabel(schema: unknown, translator: Translator = defaultTranslator): string {
  const { t } = translator
  if (!isSchema(schema)) return t("marketplace.toolGuide.type.value")
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.slice(0, 6).map(String).join(", ")
    return t("marketplace.toolGuide.type.oneOf", { values: `${values}${schema.enum.length > 6 ? "…" : ""}` })
  }
  const raw = schema.type
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  const labels = list.filter((item): item is string => typeof item === "string" && item !== "null").map((item) => typeLabel(item, translator))
  if (labels.length === 0) {
    const alternatives = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined
    if (alternatives) {
      const parts = [...new Set(alternatives.map((item) => schemaTypeLabel(item, translator)))]
      return parts.join(t("marketplace.toolGuide.type.or")) || t("marketplace.toolGuide.type.value")
    }
    return t("marketplace.toolGuide.type.value")
  }
  if (labels[0] === t("marketplace.toolGuide.type.array") && isSchema(schema.items)) return t("marketplace.toolGuide.type.listOf", { item: schemaTypeLabel(schema.items, translator) })
  return labels.join(t("marketplace.toolGuide.type.or"))
}

/** Guia de uma tool MCP a partir do snapshot do `listTools()`. */
export function mcpToolGuide(tool: McpToolInfo, translator: Translator = defaultTranslator): ToolGuideData {
  const schema = isSchema(tool.inputSchema) ? tool.inputSchema : {}
  const properties = isSchema(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [])
  const readOnly = isReadOnlyMcpTool(tool)
  const destructive = tool.annotations?.destructiveHint === true
  return {
    title: tool.title || tool.annotations?.title || tool.name,
    code: tool.name,
    access: readOnly ? translator.t("marketplace.toolGuide.accessRead") : destructive ? translator.t("marketplace.toolGuide.accessWriteDelete") : translator.t("marketplace.toolGuide.accessWrite"),
    accessTone: readOnly ? "read" : "write",
    description: tool.description?.trim() || undefined,
    params: Object.entries(properties).map(([name, value]) => ({
      name,
      type: schemaTypeLabel(value, translator),
      required: required.has(name),
      description: isSchema(value) && typeof value.description === "string" ? value.description.trim() : undefined,
    })),
  }
}

const PLACE_KEYS = { path: "marketplace.toolGuide.placePath", query: "marketplace.toolGuide.placeQuery" } as const satisfies Record<string, MessageKey>
const API_TYPE_KEYS = {
  string: "marketplace.toolGuide.type.string",
  number: "marketplace.toolGuide.type.number",
  integer: "marketplace.toolGuide.type.integer",
  boolean: "marketplace.toolGuide.type.boolean",
} as const satisfies Record<string, MessageKey>

/** Guia de uma operação do catálogo da API. Só leitura é liberada ao agente nesta etapa. */
export function apiOperationGuide(operation: ApiOperation, { t }: Translator = defaultTranslator): ToolGuideData {
  const read = operation.method === "GET" || operation.method === "HEAD"
  return {
    title: operation.summary || operation.id,
    code: `${operation.method} ${operation.path}`,
    method: operation.method,
    access: read ? t("marketplace.toolGuide.accessRead") : t("marketplace.toolGuide.accessWrite"),
    accessTone: read ? "read" : "write",
    description: undefined,
    params: operation.params.map((param) => ({
      name: param.name,
      type: param.enum?.length
        ? t("marketplace.toolGuide.type.oneOf", { values: `${param.enum.slice(0, 6).join(", ")}${param.enum.length > 6 ? "…" : ""}` })
        : Object.hasOwn(API_TYPE_KEYS, param.type)
          ? t(API_TYPE_KEYS[param.type as keyof typeof API_TYPE_KEYS])
          : param.type,
      required: param.required,
      description: param.description,
      place: Object.hasOwn(PLACE_KEYS, param.in) ? t(PLACE_KEYS[param.in as keyof typeof PLACE_KEYS]) : param.in,
    })),
    note: read ? t("marketplace.toolGuide.noteRead") : t("marketplace.toolGuide.noteWrite"),
  }
}

const TONE: Record<ToolGuideData["accessTone"], string> = {
  read: "bg-success/10 text-success",
  write: "bg-warning/10 text-warning",
  neutral: "bg-muted text-muted-foreground",
}

/** Guia de uma ferramenta: Sheet no celular, Dialog no computador (mesmo painel do fluxo "Conectar API"). */
export function ToolGuide({ guide, onClose }: { guide: ToolGuideData | null; onClose: () => void }) {
  const { t } = useTranslations()
  return (
    <FlowPanel
      description={t("marketplace.toolGuide.description")}
      onOpenChange={(open) => !open && onClose()}
      open={guide !== null}
      title={guide?.title ?? t("marketplace.toolGuide.tool")}
    >
      {guide ? <ToolGuideBody guide={guide} onClose={onClose} /> : null}
    </FlowPanel>
  )
}

export function ToolGuideBody({ guide, onClose }: { guide: ToolGuideData; onClose: () => void }) {
  const { t } = useTranslations()
  return (
    <div className="flex min-w-0 flex-col gap-4 p-5">
      <header className="min-w-0 space-y-2">
        <span className={cn("inline-flex h-5 items-center rounded-md px-1.5 text-caption font-medium", TONE[guide.accessTone])}>{guide.access}</span>
        <h2 className="m-0 text-lg leading-snug font-semibold break-words">{guide.title}</h2>
        <p className="m-0 break-all font-mono text-xs text-muted-foreground">{guide.code}</p>
      </header>
      {guide.description ? (
        <p className="m-0 max-h-40 overflow-y-auto text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">{guide.description}</p>
      ) : null}
      <section className="space-y-2">
        <h3 className="m-0 text-sm font-semibold">{t("marketplace.toolGuide.params")}</h3>
        {guide.params.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">{t("marketplace.toolGuide.noParams")}</p>
        ) : (
          <ul className="m-0 max-h-[40dvh] list-none divide-y overflow-y-auto rounded-xl border bg-muted/20 p-0">
            {guide.params.map((param) => (
              <li className="min-w-0 space-y-1 px-4 py-3" key={`${param.place ?? ""}${param.name}`}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-sm font-medium break-all">{param.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {param.type}
                    {param.place ? ` · ${param.place}` : ""}
                  </span>
                  {param.required ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-caption text-foreground">{t("marketplace.toolGuide.required")}</span> : null}
                </div>
                {param.description ? <p className="m-0 text-xs leading-5 break-words text-muted-foreground">{param.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {guide.note ? <p className="m-0 text-xs text-muted-foreground">{guide.note}</p> : null}
      <Button className="w-full" onClick={onClose} type="button" variant="secondary">
        {t("common.close")}
      </Button>
    </div>
  )
}
