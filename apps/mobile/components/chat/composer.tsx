import * as React from "react";
import { Platform, Pressable, TextInput, useWindowDimensions, View } from "react-native";

const LINE_HEIGHT = 22;
import { ArrowUpIcon, MicIcon, PlusIcon, StopIcon, WaveformIcon } from "@/components/icons";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

type ComposerProps = {
	/** Seções de cima do container único (lista de tarefas, depois aprovação), cada uma com divisor `border-b` embaixo. */
	sections?: React.ReactNode;
	botName: string;
	/** Cor do bot: o botão redondo. */
	color: string;
	running: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
	onSoon: (what: "anexos" | "voz") => void;
};

/**
 * Composer da referência: uma pílula só, numa linha ("+" num círculo, o campo "Perguntar a <bot>", o microfone num
 * círculo cinza e, colado nele, o círculo na cor do bot). O campo cresce quando o texto quebra e os botões ficam na
 * base. O botão da cor do bot é "enviar" com texto, "parar" durante o run (sem texto) e, parado e vazio, as ondas de
 * voz. Microfone e voz ainda são "em breve".
 *
 * Estrutura do web: container único (mesmo fundo `input`, e as seções de tarefas e aprovação dentro, separadas por
 * `border-b`). A borda fina por fora com respiro de 1px é o "outline + offset" da referência: o RN não tem
 * `outline-offset`, então vira uma View externa com borda e `padding: 1` em volta da pílula, sem borda própria.
 * (O web hoje usa `border border-border` simples nesse container: a diferença é só visual.)
 */
export function Composer({ sections, botName, color, running, onSend, onStop, onSoon }: ComposerProps) {
	const scheme = useAppColorScheme();
	const [text, setText] = React.useState("");
	const hasText = text.trim().length > 0;
	const [stacked, setStacked] = React.useState(false);
	const baseline = React.useRef<number | null>(null);
	const [webHeight, setWebHeight] = React.useState(0);
	// O campo cresce com o texto até 40% da tela e rola por dentro depois disso.
	const maxFieldHeight = Math.round(useWindowDimensions().height * 0.4);
	// Largura do grupo da direita: microfone + botão da cor do bot (o microfone fica também com texto).
	const rightWidth = 86;
	const mode = hasText ? "send" : running ? "stop" : "voice";
	const press = () => {
		if (mode === "send") {
			onSend(text);
			setText("");
			setStacked(false);
			baseline.current = null;
		} else if (mode === "stop") onStop();
		else onSoon("voz");
	};
	return (
		<View className="mx-4 mb-2 rounded-[29px] border border-foreground/20 p-px">
			<View className="overflow-hidden rounded-[28px] bg-input">
				{sections}
				{/*
				  Um só TextInput nos dois formatos (assim o foco e o teclado não se perdem na troca). Os botões ficam sempre
				  em posição absoluta na base: com uma linha o campo fica entre eles (pílula); quando o texto quebra, o campo
				  ocupa a largura toda e reserva uma faixa embaixo para a linha de botões ("+" à esquerda, microfone e botão
				  da cor do bot à direita), como nas referências do dono.
				*/}
				<View style={{ paddingBottom: stacked ? 48 : 0 }}>
					<TextInput
						accessibilityLabel={`Perguntar a ${botName}`}
						placeholder={`Perguntar a ${botName}`}
						placeholderTextColor={themeColor(scheme, "muted-foreground")}
						value={text}
						onChangeText={(value) => {
							setText(value);
							if (value.length === 0) {
								setStacked(false);
								baseline.current = null;
							}
						}}
						onContentSizeChange={(event) => {
							const height = event.nativeEvent.contentSize.height;
							// A altura de uma linha varia por plataforma (com ou sem o padding): a menor medida é a base.
							if (baseline.current === null || height < baseline.current) baseline.current = height;
							// Quebrou em mais de uma linha: vira retângulo. Fica assim até esvaziar (sem vai e volta).
							else if (height - baseline.current >= LINE_HEIGHT * 0.8) setStacked(true);
							// Na prévia web o campo não cresce sozinho (no celular, sim): a altura vem da medida.
							if (Platform.OS === "web") setWebHeight(height);
						}}
						multiline
						maxLength={20_000}
						textAlignVertical={stacked ? "top" : "center"}
						style={{
							fontSize: 17,
							lineHeight: LINE_HEIGHT,
							paddingTop: 9 + 8,
							paddingBottom: stacked ? 4 : 9 + 8,
							paddingLeft: stacked ? 16 : 8 + 40 + 8,
							paddingRight: stacked ? 16 : rightWidth + 8 + 8,
							minHeight: 56,
							maxHeight: maxFieldHeight,
							...(Platform.OS === "web" ? { height: Math.min(maxFieldHeight, Math.max(56, webHeight)) } : {}),
						}}
						className="text-foreground outline-none"
					/>
					<View className="absolute bottom-2 left-2 right-2 flex-row items-center justify-between" pointerEvents="box-none">
						<Pressable role="button" accessibilityLabel="Adicionar" onPress={() => onSoon("anexos")} className="size-10 items-center justify-center rounded-full bg-foreground/10 active:opacity-70">
							<PlusIcon size={20} />
						</Pressable>
						<View className="flex-row items-center gap-1.5">
							<Pressable role="button" accessibilityLabel="Microfone (em breve)" onPress={() => onSoon("voz")} className="size-10 items-center justify-center rounded-full bg-foreground/10 active:opacity-70">
								<MicIcon size={20} />
							</Pressable>
							<Pressable
								role="button"
								accessibilityLabel={mode === "send" ? "Enviar" : mode === "stop" ? "Parar" : "Voz (em breve)"}
								onPress={press}
								style={{ backgroundColor: color }}
								className="size-10 items-center justify-center rounded-full active:opacity-80"
							>
								{mode === "send" ? <ArrowUpIcon size={20} tone="primary-foreground" /> : mode === "stop" ? <StopIcon size={16} /> : <WaveformIcon size={20} />}
							</Pressable>
						</View>
					</View>
				</View>
			</View>
		</View>
	);
}
