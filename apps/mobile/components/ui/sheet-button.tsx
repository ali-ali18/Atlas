import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { SURFACE_RADIUS } from "@/lib/surfaces";

/**
 * Botão de gaveta (Salvar, Entendi, Cancelar): o tamanho da linha de ação do menu da mensagem (altura 56, `px-5`, texto
 * `text-control`) e o mesmo raio do grupo de linhas (`SURFACE_RADIUS`), largura cheia. Toda gaveta usa este, nunca um
 * `Button` com tamanho próprio. Primário = `variant` padrão; secundário = `variant="secondary"`.
 */
export function SheetButton({ className, ...props }: Omit<ButtonProps, "size" | "style">) {
	return <Button size="sheet" className={className ?? "w-full"} style={{ borderRadius: SURFACE_RADIUS }} {...props} />;
}
