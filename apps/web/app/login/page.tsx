"use client"

import { Spinner } from "@workspace/ui/components/spinner"
import { AtSignIcon, BotIcon, MailCheckIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"

import { authClient } from "@/lib/auth-client"
import { useT } from "@/lib/i18n/provider"
import { UiLocaleSwitcher } from "@/components/ui-locale-switcher"
import { GithubIcon, GoogleIcon } from "@/components/icons/social"
import { Avatar } from "@workspace/ui/components/avatar/avatar"
import { Button } from "@workspace/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group"

type Provider = "github" | "google"
type AvailableProviders = Record<Provider, boolean>

const integrations = [
  {
    name: "OpenRouter",
    src: "/connectors/openrouter-grape.svg",
    darkSrc: "/connectors/openrouter-cloud.svg",
  },
  { name: "Firecrawl", src: "/connectors/firecrawl.svg" },
]

function AuthDivider({ children }: { children: string }) {
  return (
    <div className="flex w-full items-center gap-3 text-muted-foreground text-xs">
      <div aria-hidden className="h-px flex-1 bg-border" />
      <span className="uppercase tracking-wider">{children}</span>
      <div aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

/** "Texto <em>destaque</em> texto" -> trechos, com o destaque em negrito (o idioma decide onde fica). */
function EmphasizedText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(<em>.*?<\/em>)/).map((part, index) =>
        part.startsWith("<em>") ? (
          <span className="font-medium" key={index}>{part.slice(4, -5)}</span>
        ) : (
          part
        ),
      )}
    </>
  )
}

function BrandPanel() {
  const t = useT()
  return (
    <aside className="relative hidden border-l py-12 md:flex md:flex-col md:justify-between">
      <div className="absolute inset-y-0 left-8 w-40 border-x-2 border-dashed bg-muted/20 lg:left-12 lg:w-52" />
      <div className="relative mt-16 w-full px-6 py-6 lg:mt-24 lg:px-12 lg:py-8">
        <div className="absolute md:-inset-x-5 lg:-inset-x-13 top-0 z-20 h-px bg-border mask-l-from-96%" />
        <div className="absolute md:-inset-x-5 lg:-inset-x-13 bottom-0 h-px bg-border mask-l-from-96%" />
        <div className="absolute inset-y-px right-0 left-8 z-30 bg-background lg:left-12" />
        <figure className="relative z-40 flex w-full pl-2 flex-col lg:pl-3.5">
          <div className="mb-8 flex items-center gap-2 font-semibold text-muted-foreground text-sm">
            <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
              <BotIcon className="size-4" />
            </span>
            Atlas
          </div>
          <blockquote className="max-w-xs text-xl leading-tight">
            &ldquo;<EmphasizedText text={t("login.quote")} />&rdquo;
          </blockquote>
          <figcaption className="mt-6 flex items-center gap-3">
            <Avatar
              ariaLabel={t("login.avatarLabel")}
              className="size-9 rounded-full border"
              color="#ffffff"
              id="atlas"
              shape="blob"
              size={36}
            />
            <div className="space-y-0.5">
              <cite className="font-medium text-sm not-italic">Atlas Agent</cite>
              <div className="text-muted-foreground text-xs">{t("login.tagline")}</div>
            </div>
          </figcaption>
        </figure>
        <div className="pointer-events-none absolute inset-y-0 left-8 z-50 border-l-2 border-dashed lg:left-12" />
      </div>
      <div className="relative z-10 space-y-3 px-8 py-4 lg:px-14">
        <div className="absolute -inset-x-13 top-2 z-20 h-px bg-border mask-l-from-96%" />
        <h2 className="text-muted-foreground text-sm">{t("login.allInOnePlace")}</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-2 font-medium text-muted-foreground text-sm lg:gap-x-7">
          {integrations.map(({ name, src, darkSrc }) => (
            <span className="flex items-center gap-1.5" key={name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                aria-hidden
                className={darkSrc ? "h-5 w-auto dark:hidden" : "h-5 w-auto invert dark:invert-0"}
                src={src}
              />
              {darkSrc && (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" aria-hidden className="hidden h-5 w-auto dark:block" src={darkSrc} />
              )}
              {name}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <GoogleIcon aria-hidden className="size-5 text-foreground" />
            Google
          </span>
        </div>
      </div>
    </aside>
  )
}

export default function LoginPage() {
  const t = useT()
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState<Provider | "email" | null>(null)
  const [error, setError] = useState("")
  const [emailSent, setEmailSent] = useState(false)
  const [providers, setProviders] = useState<AvailableProviders>({ github: false, google: false })
  // Evita mismatch de hidratação: `isPending` do useSession difere entre SSR
  // e primeiro render no cliente, então o `disabled` só vale após o mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const locked = !mounted || Boolean(busy) || isPending

  useEffect(() => {
    if (session?.user) router.replace("/")
  }, [router, session?.user])

  useEffect(() => {
    const controller = new AbortController()
    void fetch("/api/auth/providers", { credentials: "same-origin", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to load providers")
        return response.json() as Promise<AvailableProviders>
      })
      .then((available) => {
        setProviders({ github: available.github === true, google: available.google === true })
      })
      .catch(() => {
        // Magic link remains available when social provider discovery fails.
      })
    return () => controller.abort()
  }, [])

  const hasSocial = providers.github || providers.google

  async function signInWith(provider: Provider) {
    setError("")
    setBusy(provider)
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: "/" })
      if (result.error) setError(result.error.message || t("login.startError"))
    } catch {
      setError(t("login.startError"))
    } finally {
      setBusy(null)
    }
  }

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setBusy("email")
    try {
      const result = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: "/" })
      if (result.error) {
        setError(result.error.message || t("login.linkError"))
      } else {
        setEmailSent(true)
      }
    } catch {
      setError(t("login.linkError"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <div className="grid h-full md:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] lg:grid-cols-[1fr_0.75fr]">
        <div className="flex h-full items-center justify-center overflow-y-auto p-6 sm:p-8">
          <div className="w-full max-w-sm space-y-4">
            <div className="space-y-2 text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
                <BotIcon className="size-5" />
              </span>
              <h1 className="font-semibold text-xl tracking-tight">{t("login.title")}</h1>
              <p className="text-muted-foreground text-sm">{t("login.subtitle")}</p>
            </div>

            {hasSocial && (
              <div className="grid gap-3">
                {providers.google && (
                  <Button
                    className="w-full"
                    disabled={locked}
                    onClick={() => void signInWith("google")}
                    size="lg"
                    type="button"
                    variant="outline"
                  >
                    {busy === "google" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <GoogleIcon data-icon="inline-start" />
                    )}
                    {t("login.google")}
                  </Button>
                )}
                {providers.github && (
                  <Button
                    className="w-full"
                    disabled={locked}
                    onClick={() => void signInWith("github")}
                    size="lg"
                    type="button"
                    variant="outline"
                  >
                    {busy === "github" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <GithubIcon data-icon="inline-start" />
                    )}
                    {t("login.github")}
                  </Button>
                )}
              </div>
            )}

            {hasSocial && <AuthDivider>{t("login.or")}</AuthDivider>}

            <form className="space-y-3" onSubmit={(event) => void sendLink(event)}>
              <InputGroup>
                <InputGroupAddon>
                  <AtSignIcon />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label={t("login.emailLabel")}
                  autoComplete="email"
                  disabled={locked}
                  onChange={(event) => { setEmail(event.target.value); setEmailSent(false) }}
                  placeholder={t("login.emailPlaceholder")}
                  required
                  type="email"
                  value={email}
                />
              </InputGroup>
              <Button className="w-full" disabled={locked} size="lg" type="submit">
                {busy === "email" && <Spinner data-icon="inline-start" />}
                {t("login.sendLink")}
              </Button>
            </form>

            {emailSent && (
              <p className="flex items-center justify-center gap-1.5 text-center text-muted-foreground text-sm" role="status">
                <MailCheckIcon className="size-4" />
                {t("login.linkSent")}
              </p>
            )}
            {error && <p className="text-center text-destructive text-sm" role="alert">{error}</p>}

            <p className="text-center text-muted-foreground text-xs">
              {t("login.privateInstance")}
            </p>
            <UiLocaleSwitcher />
          </div>
        </div>
        <BrandPanel />
      </div>
    </main>
  )
}
