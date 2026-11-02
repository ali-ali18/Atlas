import * as React from "react";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";

/**
 * "Selecionar texto": o texto inteiro da mensagem numa gaveta arrastável, onde dá para selecionar à vontade. Abre na
 * altura do texto (até 60% da tela) e sobe até o topo ao puxar a alça. O balão em si não é selecionável (o toque
 * longo abre o menu) e o Android não seleciona por código, então a seleção mora aqui.
 */
export function TextSelectModal({ text, onClose }: { text: string | null; onClose: () => void }) {
	// Mantém o último texto durante a saída da gaveta, para ela não esvaziar enquanto some.
	const last = React.useRef("");
	if (text !== null) last.current = text;
	return (
		<DraggableSheet visible={text !== null} onClose={onClose} header={<Text variant="heading">Selecionar texto</Text>}>
			<Text selectable className="text-control leading-6">
				{text ?? last.current}
			</Text>
		</DraggableSheet>
	);
}
