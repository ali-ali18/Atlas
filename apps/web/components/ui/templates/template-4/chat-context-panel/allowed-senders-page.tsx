"use client"

import { useMemo, useState } from "react"
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workspace/ui/components/input-group"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { useBotEmail } from "@/hooks/use-bot-email"
import { closeSendersPage } from "@/lib/email-senders-url"
import { EMAIL_EMPTY_ALLOWED, addAllowedSender, filterAllowedSenders, moreSendersLabel } from "./bot-email-helpers"

const sendersCount = (count: number) => moreSendersLabel(count).replace("+", "")

/** Lista e formulário da página (separado do carregamento para testar sem rede). */
export function AllowedSendersManager({
  senders,
  busy,
  error,
  onChange,
  initialQuery = "",
}: {
  senders: string[]
  busy: boolean
  error?: string | null
  onChange: (next: string[]) => Promise<boolean>
  initialQuery?: string
}) {
  const [query, setQuery] = useState(initialQuery)
  const [value, setValue] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const visible = useMemo(() => filterAllowedSenders(senders, query), [senders, query])
  const filtering = query.trim() !== ""

  async function add() {
    const result = addAllowedSender(senders, value)
    if (!result.ok) {
      setAddError(result.error)
      return
    }
    setAddError(null)
    if (await onChange(result.next)) setValue("")
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="allowed-senders-page">
      <form
        className="flex min-w-0 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <Input
          aria-invalid={addError ? true : undefined}
          aria-label="Adicionar remetente permitido"
          autoComplete="off"
          className="min-w-0 flex-1"
          disabled={busy}
          inputMode="email"
          onChange={(event) => {
            setValue(event.target.value)
            setAddError(null)
          }}
          placeholder="e-mail ou @domínio"
          spellCheck={false}
          value={value}
        />
        <Button disabled={busy || !value.trim()} size="sm" type="submit" variant="outline">
          Adicionar
        </Button>
      </form>
      {addError || error ? (
        <p className="-mt-3 text-destructive text-xs" role="alert">
          {addError ?? error}
        </p>
      ) : null}

      {senders.length === 0 ? (
        <p className="rounded-2xl border border-border border-dashed px-3 py-6 text-center text-muted-foreground text-xs leading-relaxed" data-testid="senders-empty">
          {EMAIL_EMPTY_ALLOWED}
        </p>
      ) : (
        <section aria-labelledby="senders-list-title" className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <h2 className="font-medium text-muted-foreground text-xs" id="senders-list-title">
              Remetentes
            </h2>
            <span className="text-muted-foreground text-xs" data-testid="senders-count">
              {filtering ? `${visible.length} de ${sendersCount(senders.length)}` : sendersCount(senders.length)}
            </span>
          </div>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Buscar remetente"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar remetente"
              spellCheck={false}
              type="search"
              value={query}
            />
          </InputGroup>
          {visible.length === 0 ? (
            <p className="rounded-2xl border border-border border-dashed px-3 py-6 text-center text-muted-foreground text-xs" data-testid="senders-no-match">
              Nenhum remetente encontrado para “{query.trim()}”.
            </p>
          ) : (
            <ul aria-label="Remetentes permitidos" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {visible.map((rule) => (
                <li className="flex h-10 min-w-0 items-center gap-2 rounded-2xl border border-border bg-card pr-1 pl-3" data-allowed-sender={rule} key={rule}>
                  <span className="min-w-0 flex-1 truncate text-sm">{rule}</span>
                  <Button
                    aria-label={`Remover ${rule}`}
                    className="shrink-0 text-muted-foreground"
                    disabled={busy}
                    onClick={() => void onChange(senders.filter((item) => item !== rule))}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

/** Página inteira dos remetentes permitidos do bot (aberta por "Ver todos" na aba E-mail). */
export function AllowedSendersPage({ botId }: { botId: string }) {
  const email = useBotEmail(botId, true)
  const mailbox = email.data?.mailbox ?? null
  return (
    <main aria-label="Remetentes permitidos" className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background" data-slot="allowed-senders-page">
      <header className="z-20 shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-[720px] items-center gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 md:px-8 md:pt-6">
          <Button aria-label="Voltar" className="-ml-2 shrink-0" onClick={closeSendersPage} size="icon" type="button" variant="ghost">
            <ArrowLeftIcon aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold text-lg md:text-xl">Remetentes permitidos</h1>
            {mailbox ? (
              <p className="truncate text-muted-foreground text-xs" data-testid="senders-address" title={mailbox.address}>
                {mailbox.address}
              </p>
            ) : null}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-[720px] px-4 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom))] md:px-8">
          {email.loading && !email.data ? (
            <div aria-busy="true" aria-label="Carregando os remetentes" className="flex flex-col gap-3" role="status">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : email.loadError && !email.data ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
              <p className="text-muted-foreground text-xs leading-relaxed">{email.loadError}</p>
              <Button onClick={() => void email.refresh()} size="sm" variant="outline">
                Tentar de novo
              </Button>
            </div>
          ) : !mailbox ? (
            <p className="rounded-2xl border border-border border-dashed px-3 py-6 text-center text-muted-foreground text-xs leading-relaxed">
              Este bot ainda não tem um endereço de e-mail. Ative na aba E-mail.
            </p>
          ) : (
            <AllowedSendersManager
              busy={email.busy}
              error={email.actionError}
              onChange={(allowedSenders) => email.patch({ allowedSenders })}
              senders={mailbox.allowedSenders}
            />
          )}
        </div>
      </div>
    </main>
  )
}
