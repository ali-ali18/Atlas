import * as React from "react";
import { Loader2Icon } from "lucide-react";

import { cn } from "../lib/utils";

export type SpinnerProps = Omit<React.ComponentProps<typeof Loader2Icon>, "aria-label"> & {
  /** Rótulo para leitor de tela. Sem rótulo o ícone é decorativo (`aria-hidden`). */
  label?: string;
};

/**
 * Indicador de carregamento único. Gira só com `motion-safe` (respeita
 * "reduzir movimento"); o tamanho vem do `className` (`size-4` por padrão).
 */
function Spinner({ className, label, ...props }: SpinnerProps) {
  return (
    <Loader2Icon
      data-slot="spinner"
      className={cn("size-4 shrink-0 motion-safe:animate-spin", className)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      {...props}
    />
  );
}

export { Spinner };
