"use client"

import { useEffect, useState, type FormEvent } from "react"
import type { ApiProposal } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card"
import { cn } from "@workspace/ui/lib/utils"
import { FlowPanel } from "@/components/ai-elements/login/flow-panel"
import { ApiConnectFlow } from "@/components/ai-elements/login/api-connect-sheet"
import { useApiConnect } from "@/hooks/use-api-connection"
import { discoverApi } from "@/lib/atlas-api"

const NOT_FOUND =
  "Não encontrei a especificação da API nesse link. Tente o link do arquivo OpenAPI (.json ou .yaml)."

/** Primeiro passo do caminho manual: o link; o servidor lê a especificação ao continuar. */
export function ApiLinkStep({
  value,
  onChange,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  busy: boolean
  error?: string | null
  onCancel: () => void
  onSubmit: () => void
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && value.trim()) onSubmit()
  }
  return (
    <form onSubmit={submit}>
      <div className="flex items-center justify-end px-4 pt-4">
        <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancelar
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-4 pt-2 pb-2">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-base font-semibold">Link da API</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Cole o link da documentação ou do arquivo OpenAPI.
          </p>
        </div>
        <Input
          aria-label="Link da API"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          disabled={busy}
          inputMode="url"
          onChange={(event) => onChange(event.target.value)}
          placeholder="https://exemplo.com/openapi.json"
          spellCheck={false}
          type="url"
          value={value}
        />
        {error ? (
          <p className="m-0 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="px-4 pt-2">
        <Button
          className={cn("w-full", REQUEST_PRIMARY_CLASS)}
          disabled={busy || !value.trim()}
          type="submit"
        >
          {busy ? "Lendo…" : "Continuar"}
        </Button>
      </div>
    </form>
  )
}

/** Depois do link: as mesmas etapas da folha do card (credenciais, acesso, autorizar). */
function ManualFlow({
  proposal,
  onClose,
  newAccount = false,
}: {
  proposal: ApiProposal
  onClose: () => void
  newAccount?: boolean
}) {
  const api = useApiConnect(proposal, false, { newAccount })
  useEffect(() => {
    if (api.justConnected) onClose()
  }, [api.justConnected, onClose])
  return (
    <ApiConnectFlow
      anotherAccount={newAccount}
      busy={api.busy}
      error={api.error}
      onOpenChange={(open) => !open && !api.busy && onClose()}
      onSubmit={(form) => void api.connect(form)}
      proposal={proposal}
    />
  )
}

/** "Adicionar outra conta" de uma API já conectada: a mesma folha de passos, criando uma conexão nova. */
export function ApiAddAccount({
  proposal,
  onClose,
  onConnected,
}: {
  proposal: ApiProposal | null
  onClose: () => void
  onConnected: () => void
}) {
  return (
    <FlowPanel
      description="Credenciais e acesso da nova conta"
      onOpenChange={(next) => !next && onClose()}
      open={!!proposal}
      title="Adicionar outra conta"
    >
      {proposal ? (
        <ManualFlow
          newAccount
          onClose={() => {
            onConnected()
            onClose()
          }}
          proposal={proposal}
        />
      ) : null}
    </FlowPanel>
  )
}

/** "Conectar API" nos Conectores: link, depois a mesma folha de passos do card do chat. */
export function ApiManualConnect({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [url, setUrl] = useState("")
  const [proposal, setProposal] = useState<ApiProposal | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    setUrl("")
    setProposal(null)
    setError(null)
    onOpenChange(false)
  }
  async function discover() {
    setBusy(true)
    setError(null)
    try {
      setProposal(await discoverApi(url.trim()))
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : NOT_FOUND)
    } finally {
      setBusy(false)
    }
  }
  return (
    <FlowPanel
      description="Link, credenciais e acesso da API"
      onOpenChange={(next) => !next && !busy && close()}
      open={open}
      title="Conectar API"
    >
      {proposal ? (
        <ManualFlow onClose={close} proposal={proposal} />
      ) : (
        <ApiLinkStep
          busy={busy}
          error={error}
          onCancel={close}
          onChange={setUrl}
          onSubmit={() => void discover()}
          value={url}
        />
      )}
    </FlowPanel>
  )
}
