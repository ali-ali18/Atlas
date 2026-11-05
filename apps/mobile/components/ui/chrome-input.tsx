import * as React from "react";
import { TextInput } from "react-native";
import { cn } from "@/lib/cn";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";

export type ChromeInputProps = React.ComponentProps<typeof TextInput> & {
	/** Ícone à esquerda (lupa, cadeado…). */
	left?: React.ReactNode;
	invalid?: boolean;
	/** Só leitura (ex.: e-mail do login): mesma pele do campo editável, sem cursor nem teclado. */
	readOnly?: boolean;
	/** Classe do contêiner (ex.: `flex-1`). */
	containerClassName?: string;
};

/**
 * Campo arredondado com borda (busca, nome, login): pílula `h-11` com `chromeFill`/`chromeEdge`, a MESMA pele do
 * composer e dos botões do topo do chat. Monta `InputGroup` + ícone opcional + `InputGroupInput`; para layouts
 * especiais use essas peças direto (elas já trazem a pele). `className` vai para o texto, não para a caixa.
 */
export function ChromeInput({ left, invalid, readOnly, containerClassName, className, ...props }: ChromeInputProps) {
	return (
		<InputGroup invalid={invalid} className={containerClassName}>
			{left ? <InputGroupAddon>{left}</InputGroupAddon> : null}
			<InputGroupInput className={cn(left ? "" : "px-5", "web:outline-none", readOnly && "opacity-100", className)} {...props} {...(readOnly ? { editable: false, caretHidden: true, selectTextOnFocus: false, autoFocus: false } : null)} />
		</InputGroup>
	);
}
