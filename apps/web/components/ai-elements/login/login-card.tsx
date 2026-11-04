"use client";

import { useState } from "react";
import { CheckIcon, ClockIcon, KeyRoundIcon, LaptopIcon, LogInIcon, MonitorIcon, ShieldCheckIcon, ShieldQuestionIcon, SkipForwardIcon } from "lucide-react";
import type { LoginVaultOffer, LoginWaitOutcome } from "@workspace/shared";

import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { ChatCard, ChatCardLine } from "@workspace/ui/components/chat-card";
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card";
import { useTranslations } from "@/lib/i18n/provider";
import { loginOutcomeBadge, ownerWaitDeadlineText } from "@/lib/owner-wait";

export type LoginCardProps = {
  site: string;
  status?: "pending" | "done";
  /** `captcha`: o site pediu verificação humana (padrão: login). */
  reason?: "login" | "captcha";
  /** Sem sessão da VM conhecida o botão do viewer fica desabilitado. */
  canOpenViewer?: boolean;
  onOpenViewer?: () => void;
  onDone?: () => void;
  /** Há login do Cofre para este site: o card oferece "Entrar" (o runtime preenche) ou "Eu faço". */
  vault?: LoginVaultOffer;
  onUseVault?: () => void;
  /** O Cofre já foi usado e o site pediu mais um passo: explica o que falta. */
  vaultTried?: string;
  /** Sem login no Cofre: atalho para salvar um (Configurações → Cofre com o domínio preenchido). */
  onSaveToVault?: () => void;
  /** O site pediu um código (e-mail/SMS): campo no card; o valor vai ao runtime, não ao modelo. */
  codeField?: boolean;
  onSubmitCode?: (code: string) => void;
  /** Motor v3: o cartão oferece Pular · Terminei · Assumir e, decidido, mostra o selo da saída. */
  ownerWait?: boolean;
  outcome?: LoginWaitOutcome;
  /** Motor v3: prazo (ISO): "Sigo sem isso às 14:30". */
  deadlineAt?: string;
  onSkip?: () => void;
  onTakeover?: () => void;
  /** Motor v3: última captura da tela da VM (toque abre o computador). */
  screenshotUrl?: string | null;
  /** Relógio injetável (testes). */
  now?: Date;
  timeZone?: string;
};

/**
 * O agente parou numa tela de login. Com login do Cofre para o site, o card
 * oferece "Entrar" (o runtime preenche; a senha nunca passa pelo modelo) ou
 * "Eu faço". Sem ele, o usuário entra pelo viewer da VM e clica em "Terminei"
 * para retomar o run, e ganha o atalho para salvar o login no Cofre.
 * Mesma casca dos outros pedidos: a ação principal vem primeiro.
 */
export function LoginCard({
  site,
  status = "pending",
  reason = "login",
  canOpenViewer = true,
  onOpenViewer,
  onDone,
  vault,
  onUseVault,
  vaultTried,
  onSaveToVault,
  codeField,
  onSubmitCode,
  ownerWait = false,
  outcome,
  deadlineAt,
  onSkip,
  onTakeover,
  screenshotUrl,
  now,
  timeZone,
}: LoginCardProps) {
  const translator = useTranslations();
  const { t } = translator;
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState("");
  const done = status === "done";
  const captcha = reason === "captcha";

  // Login do Cofre usado pelo runtime (sem aprovação): só uma linha discreta, sem cartão.
  if (vault && done && !captcha) {
    return (
      <ChatCard className="my-1 text-xs" data-testid="vault-login-used" variant="activity">
        <ChatCardLine leading={<KeyRoundIcon aria-label={t("aiElements.login.vaultLabel")} />}>
          <span className="text-muted-foreground">
            {t("aiElements.login.vaultUsed", { site, item: vault.label || vault.name })}
          </span>
        </ChatCardLine>
      </ChatCard>
    );
  }

  if (vault && !captcha && !manual) {
    const who = vault.username ? ` (${vault.username})` : "";
    return (
      <RequestCard
        actions={
          <>
            <Button className={REQUEST_PRIMARY_CLASS} onClick={onUseVault} size="sm" type="button">
              {t("aiElements.login.enter")}
            </Button>
            <Button onClick={() => setManual(true)} size="sm" type="button" variant="secondary">
              {t("aiElements.login.iDoIt")}
            </Button>
          </>
        }
        badge={done ? { tone: "success", label: t("aiElements.login.done") } : { tone: "pending", label: t("aiElements.login.needsYou") }}
        description={
          done
            ? t("aiElements.login.resuming")
            : vault.emailCode
              ? t("aiElements.login.vaultEmailCode", { email: vault.emailCode })
              : t("aiElements.login.vaultDescription")
        }
        leading={done ? <CheckIcon aria-label={t("aiElements.login.completedLabel")} /> : <KeyRoundIcon aria-label={t("aiElements.login.vaultLabel")} />}
        resolved={done}
        title={
          done
            ? t("aiElements.login.doneTitle", { site })
            : vault.emailCode
              ? t("aiElements.login.vaultTitleEmail", { site, who, email: vault.emailCode })
              : t("aiElements.login.vaultTitle", { site, who })
        }
      />
    );
  }

  if (ownerWait && !codeField) {
    return (
      <OwnerHandoffCard
        canOpenViewer={canOpenViewer}
        captcha={captcha}
        deadline={done ? null : ownerWaitDeadlineText(deadlineAt, now ?? new Date(), translator, timeZone ? { timeZone } : {})}
        done={done}
        onDone={onDone}
        onOpenViewer={onOpenViewer}
        onSkip={onSkip}
        onTakeover={onTakeover}
        outcome={outcome}
        screenshotUrl={screenshotUrl}
        site={site}
      />
    );
  }

  const Icon = done ? CheckIcon : captcha ? ShieldQuestionIcon : LogInIcon;
  const iconLabel = done
    ? captcha
      ? t("aiElements.login.captchaDone")
      : t("aiElements.login.completedLabel")
    : captcha
      ? t("aiElements.login.captchaNeeded")
      : t("aiElements.login.loginNeeded");
  const askCode = codeField && !done && !captcha;
  const canSave = !done && !captcha && !vault && !vaultTried && Boolean(onSaveToVault);
  return (
    <RequestCard
      actions={
        <>
          {askCode ? (
            <Button
              className={REQUEST_PRIMARY_CLASS}
              disabled={code.trim().length < 3}
              onClick={() => onSubmitCode?.(code.trim())}
              size="sm"
              type="button"
            >
              {t("aiElements.login.sendCode")}
            </Button>
          ) : null}
          <Button
            className={askCode ? undefined : REQUEST_PRIMARY_CLASS}
            variant={askCode ? "secondary" : undefined}
            disabled={!canOpenViewer}
            onClick={onOpenViewer}
            size="sm"
            type="button"
          >
            {t("aiElements.login.openVm")}
          </Button>
          <Button onClick={onDone} size="sm" type="button" variant="secondary">
            {t("aiElements.login.finished")}
          </Button>
        </>
      }
      badge={
        done
          ? { tone: "success", label: t("aiElements.login.done") }
          : { tone: "pending", label: t("aiElements.login.needsYou") }
      }
      description={
        done
          ? t("aiElements.login.resuming")
          : captcha
            ? t("aiElements.login.captchaHelp")
            : vaultTried
              ? t("aiElements.login.triedHelp", { tried: vaultTried })
              : t("aiElements.login.loginHelp")
      }
      leading={<Icon aria-label={iconLabel} />}
      resolved={done}
      title={
        done
          ? captcha
            ? t("aiElements.login.captchaDoneTitle", { site })
            : t("aiElements.login.doneTitle", { site })
          : captcha
            ? t("aiElements.login.captchaTitle", { site })
            : t("aiElements.login.loginTitle", { site })
      }
      children={
        askCode ? (
          <Input
            aria-label={t("aiElements.login.codeLabel")}
            autoComplete="one-time-code"
            className="max-w-48 font-mono tracking-widest"
            data-slot="login-code-input"
            inputMode="numeric"
            maxLength={12}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && code.trim().length >= 3) onSubmitCode?.(code.trim());
            }}
            placeholder={t("aiElements.login.codePlaceholder")}
            spellCheck={false}
            value={code}
          />
        ) : null
      }
      trailing={
        canSave ? (
          <Button data-slot="login-save-to-vault" onClick={onSaveToVault} size="sm" type="button" variant="ghost">
            <KeyRoundIcon aria-hidden="true" /> {t("aiElements.login.saveToVault")}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * Cartão "Computador" do motor v3 (handoff; referência do dono, 04/11): rótulo "Computador", título "Ação necessária",
 * a instrução gerada do site, a última captura da tela da VM (toque abre o computador) e as pílulas Pular · Terminei ·
 * Assumir (a principal, clara, na ponta). Toda saída vira resultado para o bot (Pular não encerra a tarefa). Fora do
 * cartão, a nota de que o login fica no navegador do computador do bot. Decidido, só o selo da saída fica.
 */
function OwnerHandoffCard({
  site,
  captcha,
  done,
  outcome,
  deadline,
  canOpenViewer,
  screenshotUrl,
  onOpenViewer,
  onDone,
  onSkip,
  onTakeover,
}: {
  site: string;
  captcha: boolean;
  done: boolean;
  outcome?: LoginWaitOutcome;
  deadline: string | null;
  canOpenViewer: boolean;
  screenshotUrl?: string | null;
  onOpenViewer?: () => void;
  onDone?: () => void;
  onSkip?: () => void;
  onTakeover?: () => void;
}) {
  const translator = useTranslations();
  const { t } = translator;
  if (done) {
    const badge = loginOutcomeBadge(outcome, translator);
    const finished = (outcome ?? "done") === "done";
    return (
      <RequestCard
        badge={{ tone: badge.tone, label: badge.label }}
        data-login-outcome={outcome ?? "done"}
        description={badge.body}
        label={t("ownerWait.handoff.label")}
        leading={finished ? <CheckIcon aria-hidden /> : outcome === "takeover" ? <MonitorIcon aria-hidden /> : outcome === "skipped_timeout" ? <ClockIcon aria-hidden /> : <SkipForwardIcon aria-hidden />}
        resolved
        title={captcha ? t("aiElements.login.captchaTitle", { site }) : t("aiElements.login.loginTitle", { site })}
      />
    );
  }
  const body = captcha ? t("ownerWait.handoff.captchaBody", { site }) : t("ownerWait.handoff.body", { site });
  return (
    <div className="flex min-w-0 flex-col gap-2" data-owner-card="handoff">
      <RequestCard
        actions={
          <>
            <Button className={REQUEST_PRIMARY_CLASS} onClick={onTakeover} size="sm" type="button">
              {t("ownerWait.takeover")}
            </Button>
            <Button onClick={onDone} size="sm" type="button" variant="secondary">
              {t("ownerWait.done")}
            </Button>
            <Button onClick={onSkip} size="sm" type="button" variant="secondary">
              {t("ownerWait.skip")}
            </Button>
          </>
        }
        trailing={
          !screenshotUrl && canOpenViewer ? (
            <Button onClick={onOpenViewer} size="sm" type="button" variant="ghost">
              <MonitorIcon aria-hidden /> {t("ownerWait.handoff.preview")}
            </Button>
          ) : undefined
        }
        badge={{ tone: "pending", label: t("aiElements.login.needsYou") }}
        description={body}
        label={t("ownerWait.handoff.label")}
        leading={captcha ? <ShieldQuestionIcon aria-hidden /> : <LaptopIcon aria-hidden />}
        note={
          deadline ? (
            <span className="inline-flex items-center gap-1" data-slot="owner-wait-deadline">
              <ClockIcon aria-hidden className="size-3.5" />
              {deadline}
            </span>
          ) : undefined
        }
        title={t("ownerWait.handoff.title")}
      >
        {screenshotUrl ? (
          <button
            aria-label={t("ownerWait.handoff.preview")}
            className="block w-full overflow-hidden rounded-card border border-border/60 bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-default"
            data-slot="handoff-preview"
            disabled={!canOpenViewer}
            onClick={onOpenViewer}
            type="button"
          >
            {/* Última captura da VM (a prévia ao vivo fica para o próximo PR). */}
            <img alt={t("ownerWait.handoff.previewAlt")} className="block aspect-video w-full object-cover object-top" loading="lazy" src={screenshotUrl} />
          </button>
        ) : null}
      </RequestCard>
      <p className="m-0 flex items-start gap-2 px-5 text-caption text-muted-foreground" data-slot="handoff-note">
        <ShieldCheckIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>{t("ownerWait.handoff.note")}</span>
      </p>
    </div>
  );
}
