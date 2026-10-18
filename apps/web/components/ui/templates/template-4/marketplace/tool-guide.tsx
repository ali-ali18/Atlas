"use client"

import { isReadOnlyMcpTool, type ApiOperation, type McpToolInfo } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { FlowPanel } from "@/components/ai-elements/login/flow-panel"

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

const TYPE_LABEL: Record<string, string> = {
  string: "texto",
  number: "número",
  integer: "número inteiro",
  boolean: "sim ou não",
  object: "objeto",
  array: "lista",
  null: "vazio",
}

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Tipo legível de um trecho de JSON Schema ("texto", "lista de número", "uma de: a, b"). */
export function schemaTypeLabel(schema: unknown): string {
  if (!isSchema(schema)) return "valor"
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.slice(0, 6).map(String).join(", ")
    return `uma de: ${values}${schema.enum.length > 6 ? "…" : ""}`
  }
  const raw = schema.type
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  const labels = list.filter((item): item is string => typeof item === "string" && item !== "null").map((item) => TYPE_LABEL[item] ?? item)
  if (labels.length === 0) {
    const alternatives = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined
    if (alternatives) {
      const parts = [...new Set(alternatives.map(schemaTypeLabel))]
      return parts.join(" ou ") || "valor"
    }
    return "valor"
  }
  if (labels[0] === "lista" && isSchema(schema.items)) return `lista de ${schemaTypeLabel(schema.items)}`
  return labels.join(" ou ")
}

/** Guia de uma tool MCP a partir do snapshot do `listTools()`. */
export function mcpToolGuide(tool: McpToolInfo): ToolGuideData {
  const schema = isSchema(tool.inputSchema) ? tool.inputSchema : {}
  const properties = isSchema(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [])
  const readOnly = isReadOnlyMcpTool(tool)
  const destructive = tool.annotations?.destructiveHint === true
  return {
    title: tool.title || tool.annotations?.title || tool.name,
    code: tool.name,
    access: readOnly ? "Leitura" : destructive ? "Escrita · pode apagar" : "Escrita",
    accessTone: readOnly ? "read" : "write",
    description: tool.description?.trim() || undefined,
    params: Object.entries(properties).map(([name, value]) => ({
      name,
      type: schemaTypeLabel(value),
      required: required.has(name),
      description: isSchema(value) && typeof value.description === "string" ? value.description.trim() : undefined,
    })),
  }
}

const PLACE_LABEL: Record<string, string> = { path: "no caminho", query: "na consulta" }
const API_TYPE_LABEL: Record<string, string> = { string: "texto", number: "número", integer: "número inteiro", boolean: "sim ou não" }

/** Guia de uma operação do catálogo da API. Só leitura é liberada ao agente nesta etapa. */
export function apiOperationGuide(operation: ApiOperation): ToolGuideData {
  const read = operation.method === "GET" || operation.method === "HEAD"
  return {
    title: operation.summary || operation.id,
    code: `${operation.method} ${operation.path}`,
    method: operation.method,
    access: read ? "Leitura" : "Escrita",
    accessTone: read ? "read" : "write",
    description: undefined,
    params: operation.params.map((param) => ({
      name: param.name,
      type: param.enum?.length ? `uma de: ${param.enum.slice(0, 6).join(", ")}${param.enum.length > 6 ? "…" : ""}` : (API_TYPE_LABEL[param.type] ?? param.type),
      required: param.required,
      description: param.description,
      place: PLACE_LABEL[param.in] ?? param.in,
    })),
    note: read
      ? "O agente pode usar esta consulta quando o grupo estiver liberado."
      : "Ações de escrita chegam em breve: o agente ainda não pode usar esta operação.",
  }
}

const TONE: Record<ToolGuideData["accessTone"], string> = {
  read: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  write: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  neutral: "bg-muted text-muted-foreground",
}

/** Guia de uma ferramenta: Sheet no celular, Dialog no computador (mesmo painel do fluxo "Conectar API"). */
export function ToolGuide({ guide, onClose }: { guide: ToolGuideData | null; onClose: () => void }) {
  return (
    <FlowPanel
      description="Guia da ferramenta: o que ela faz e quais dados recebe"
      onOpenChange={(open) => !open && onClose()}
      open={guide !== null}
      title={guide?.title ?? "Ferramenta"}
    >
      {guide ? <ToolGuideBody guide={guide} onClose={onClose} /> : null}
    </FlowPanel>
  )
}

export function ToolGuideBody({ guide, onClose }: { guide: ToolGuideData; onClose: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 p-5">
      <header className="min-w-0 space-y-2">
        <span className={cn("inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium", TONE[guide.accessTone])}>{guide.access}</span>
        <h2 className="m-0 text-lg leading-snug font-semibold break-words">{guide.title}</h2>
        <p className="m-0 break-all font-mono text-xs text-muted-foreground">{guide.code}</p>
      </header>
      {guide.description ? (
        <p className="m-0 max-h-40 overflow-y-auto text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">{guide.description}</p>
      ) : null}
      <section className="space-y-2">
        <h3 className="m-0 text-sm font-semibold">Parâmetros</h3>
        {guide.params.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">Não recebe nenhum dado.</p>
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
                  {param.required ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground">obrigatório</span> : null}
                </div>
                {param.description ? <p className="m-0 text-xs leading-5 break-words text-muted-foreground">{param.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {guide.note ? <p className="m-0 text-xs text-muted-foreground">{guide.note}</p> : null}
      <Button className="w-full" onClick={onClose} type="button" variant="secondary">
        Fechar
      </Button>
    </div>
  )
}
