import * as React from "react";
import { View } from "react-native";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { ChromeInput } from "@/components/ui/chrome-input";
import { ChromePill } from "@/components/ui/chrome-pill";
import { Text } from "@/components/ui/text";

export type ChatSearchBarProps = {
	/** Texto do campo (o debounce fica com quem usa). */
	value: string;
	onChange: (value: string) => void;
	/** "2 de 5" quando há ocorrência atual; vazio sem busca. */
	positionLabel: string;
	/** Há consulta e nada foi achado: mostra "Nada encontrado". */
	empty: boolean;
	/** Sem ocorrências as setas ficam desligadas. */
	canStep: boolean;
	onPrevious: () => void;
	onNext: () => void;
	onClose: () => void;
};

/**
 * Barra de busca da conversa: ocupa o lugar do composer. Campo com lupa (a mesma pele do "Buscar" da home), setas
 * anterior/próxima (`ChromeButton`) e "Concluído" (`ChromePill`). A posição ("2 de 5") e o "Nada encontrado" vão numa linha
 * discreta acima, para o campo não ficar apertado.
 */
export function ChatSearchBar({ value, onChange, positionLabel, empty, canStep, onPrevious, onNext, onClose }: ChatSearchBarProps) {
	const status = empty ? "Nada encontrado" : positionLabel;
	return (
		<View className="px-4 pb-3 pt-2">
			<View className="h-5 justify-center px-2" accessibilityLiveRegion="polite">
				{status ? <Text variant="caption">{status}</Text> : null}
			</View>
			<View className="flex-row items-center gap-2">
				<ChromeInput
					containerClassName="flex-1"
					left={<SearchIcon />}
					value={value}
					onChangeText={onChange}
					placeholder="Buscar"
					autoFocus
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					clearButtonMode="while-editing"
					onSubmitEditing={onNext}
					blurOnSubmit={false}
					accessibilityLabel="Buscar na conversa"
				/>
				<ChromeButton size="md" label="Ocorrência anterior" onPress={onPrevious} disabled={!canStep}>
					<ChevronUpIcon size={22} tone="foreground" />
				</ChromeButton>
				<ChromeButton size="md" label="Próxima ocorrência" onPress={onNext} disabled={!canStep}>
					<ChevronDownIcon size={22} tone="foreground" />
				</ChromeButton>
				<ChromePill height={44} onPress={onClose} label="Concluído" className="px-4">
					<Text className="text-control font-semibold">Concluído</Text>
				</ChromePill>
			</View>
		</View>
	);
}
