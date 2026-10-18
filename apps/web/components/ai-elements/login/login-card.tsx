"use client";

import { useState } from "react";
import { CheckIcon, KeyRoundIcon, LogInIcon, ShieldQuestionIcon } from "lucide-react";
import type { LoginVaultOffer } from "@workspace/shared";

import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card";

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
}: LoginCardProps) {
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState("");
  const done = status === "done";
  const captcha = reason === "captcha";

  if (vault && !captcha && !manual) {
    const who = vault.username ? ` (${vault.username})` : "";
    return (
      <RequestCard
        actions={
          <>
            <Button className={REQUEST_PRIMARY_CLASS} onClick={onUseVault} size="sm" type="button">
              Entrar
            </Button>
            <Button onClick={() => setManual(true)} size="sm" type="button" variant="secondary">
              Eu faço
            </Button>
          </>
        }
        badge={done ? { tone: "success", label: "Concluído" } : { tone: "pending", label: "Precisa de você" }}
        description={
          done
            ? "Retomando de onde parou."
            : vault.emailCode
              ? `Eu preencho usuário e senha pelo Cofre e, se o site pedir, busco o código no seu e-mail (${vault.emailCode}). Nada disso passa pelo modelo.`
              : "Eu preencho usuário e senha pelo Cofre. A senha nunca passa pelo modelo."
        }
        leading={done ? <CheckIcon aria-label="Login concluído" /> : <KeyRoundIcon aria-label="Login do Cofre" />}
        resolved={done}
        title={
          done
            ? `Login em ${site} concluído`
            : vault.emailCode
              ? `Entrar em ${site} com o login do Cofre${who} e, se pedir, buscar o código no seu e-mail (${vault.emailCode})?`
              : `Entrar em ${site} com o login do Cofre${who}?`
        }
      />
    );
  }

  const Icon = done ? CheckIcon : captcha ? ShieldQuestionIcon : LogInIcon;
  const iconLabel = done
    ? captcha
      ? "Verificação concluída"
      : "Login concluído"
    : captcha
      ? "Verificação necessária"
      : "Login necessário";
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
              Enviar código
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
            Abrir a VM
          </Button>
          <Button onClick={onDone} size="sm" type="button" variant="secondary">
            Terminei
          </Button>
        </>
      }
      badge={
        done
          ? { tone: "success", label: "Concluído" }
          : { tone: "pending", label: "Precisa de você" }
      }
      description={
        done
          ? "Retomando de onde parou."
          : captcha
            ? "Abra a VM, resolva o captcha e clique em Terminei. Eu continuo daqui."
            : vaultTried
              ? `${vaultTried} Abra a VM, resolva o que falta e clique em Terminei. Eu continuo daqui.`
              : "Abra a VM, entre na sua conta e clique em Terminei. Eu continuo daqui; sua senha nunca passa por mim."
      }
      leading={<Icon aria-label={iconLabel} />}
      resolved={done}
      title={
        done
          ? captcha
            ? `Verificação em ${site} concluída`
            : `Login em ${site} concluído`
          : captcha
            ? `${site} pediu uma verificação (captcha)`
            : `Preciso que você faça login em ${site}`
      }
      children={
        askCode ? (
          <Input
            aria-label="Código de verificação"
            autoComplete="one-time-code"
            className="max-w-48 font-mono tracking-widest"
            data-slot="login-code-input"
            inputMode="numeric"
            maxLength={12}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && code.trim().length >= 3) onSubmitCode?.(code.trim());
            }}
            placeholder="Código"
            spellCheck={false}
            value={code}
          />
        ) : null
      }
      trailing={
        canSave ? (
          <Button data-slot="login-save-to-vault" onClick={onSaveToVault} size="sm" type="button" variant="ghost">
            <KeyRoundIcon aria-hidden="true" /> Salvar um login no Cofre para a próxima vez
          </Button>
        ) : undefined
      }
    />
  );
}
