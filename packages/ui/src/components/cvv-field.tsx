"use client";

import * as React from "react";

import { cn } from "../lib/utils";
import { Input } from "./input";

/** Controle imperativo do campo: o valor NÃO passa por estado nem props do React. */
export type CvvFieldHandle = {
  /** Lê o que foi digitado (3 ou 4 dígitos) ou `""`. Chame só ao enviar. */
  read(): string;
  /** Apaga o campo. */
  clear(): void;
  focus(): void;
};

export type CvvFieldProps = Omit<
  React.ComponentProps<"input">,
  "value" | "defaultValue" | "onChange" | "type" | "name" | "maxLength" | "ref"
> & {
  /** Rótulo visível ("Código de segurança (CVV)"). */
  label: string;
  /** Linha de ajuda abaixo ("3 dígitos no verso do cartão. Não é guardado."). */
  hint?: string;
  /** Mensagem de erro (liga `aria-invalid`). */
  error?: string;
  /** Avisa só se o formato está completo (3 a 4 dígitos). Nunca recebe o valor. */
  onValidityChange?: (valid: boolean) => void;
  /** Enter com o campo completo (enviar). */
  onSubmit?: () => void;
  handleRef?: React.Ref<CvvFieldHandle>;
};

const onlyDigits = (value: string) => value.replace(/\D/g, "").slice(0, 4);

/**
 * Campo do código de segurança do cartão (CVV). Regras de segurança:
 * - o valor vive só no próprio `<input>` (não controlado): nada de `useState`, contexto, storage ou URL;
 * - `type="password"` (mascarado), `inputMode="numeric"`, `autoComplete="cc-csc"`, sem `name` (não entra em formulário nem é
 *   salvo pelo navegador), com dicas para gerenciadores de senha ignorarem;
 * - só 3 a 4 dígitos; apagado ao desmontar e por `clear()`.
 */
function CvvField({ label, hint, error, onValidityChange, onSubmit, handleRef, className, id, disabled, ...props }: CvvFieldProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const autoId = React.useId();
  const fieldId = id ?? `cvv-${autoId}`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  React.useImperativeHandle(
    handleRef,
    () => ({
      read: () => inputRef.current?.value ?? "",
      clear: () => {
        if (inputRef.current) inputRef.current.value = "";
        onValidityChange?.(false);
      },
      focus: () => inputRef.current?.focus(),
    }),
    [onValidityChange]
  );

  // Ao sair da tela o campo é esvaziado (o nó pode ser reaproveitado pelo navegador).
  React.useEffect(() => {
    const node = inputRef.current;
    return () => {
      if (node) node.value = "";
    };
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="cvv-field">
      <label className="text-body font-medium" htmlFor={fieldId}>
        {label}
      </label>
      <Input
        {...props}
        ref={inputRef}
        aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        autoCapitalize="off"
        autoComplete="cc-csc"
        autoCorrect="off"
        className={cn("max-w-32 tracking-widest", className)}
        data-1p-ignore="true"
        data-lpignore="true"
        data-slot="cvv-input"
        disabled={disabled}
        id={fieldId}
        inputMode="numeric"
        maxLength={4}
        onChange={(event) => {
          const digits = onlyDigits(event.currentTarget.value);
          if (digits !== event.currentTarget.value) event.currentTarget.value = digits;
          onValidityChange?.(digits.length === 3 || digits.length === 4);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const length = inputRef.current?.value.length ?? 0;
          if (length === 3 || length === 4) onSubmit?.();
        }}
        spellCheck={false}
        type="password"
      />
      {hint ? (
        <p className="m-0 text-caption text-muted-foreground" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="m-0 text-caption text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { CvvField };
