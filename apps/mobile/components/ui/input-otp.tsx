import * as React from "react";
import { TextInput, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { cn } from "@/lib/cn";
import { Text } from "@/components/ui/text";

// Mesmos nomes e partes do InputOTP do shadcn/ui (InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator), que o
// packages/ui não tem. No web o shadcn usa a lib `input-otp` (um <input> invisível por cima das casinhas); aqui é o
// mesmo desenho com um `TextInput` invisível, que recebe teclado numérico, preenchimento do código do e-mail e colar.

type SlotState = { char: string; isActive: boolean; hasFakeCaret: boolean };
const SlotsContext = React.createContext<SlotState[]>([]);

export type InputOTPProps = {
	value: string;
	/** Recebe o texto como veio (colado inclusive, com espaços ou traços); quem usa limpa e corta. */
	onChange: (value: string) => void;
	maxLength: number;
	editable?: boolean;
	autoFocus?: boolean;
	invalid?: boolean;
	accessibilityLabel: string;
	children: React.ReactNode;
	className?: string;
};

export function InputOTP({ value, onChange, maxLength, editable = true, autoFocus, invalid, accessibilityLabel, children, className }: InputOTPProps) {
	const [focused, setFocused] = React.useState(false);
	const activeIndex = Math.min(value.length, maxLength - 1);
	const slots = React.useMemo<SlotState[]>(
		() =>
			Array.from({ length: maxLength }, (_, index) => ({
				char: value[index] ?? "",
				isActive: focused && index === activeIndex,
				hasFakeCaret: focused && index === activeIndex && value.length < maxLength,
			})),
		[value, maxLength, focused, activeIndex],
	);
	return (
		<SlotsContext.Provider value={slots}>
			<InvalidContext.Provider value={Boolean(invalid)}>
				<View className={cn("relative w-full items-center", className)}>
					<View className="flex-row items-center" pointerEvents="none">
						{children}
					</View>
					<TextInput
						value={value}
						onChangeText={onChange}
						onFocus={() => setFocused(true)}
						onBlur={() => setFocused(false)}
						editable={editable}
						autoFocus={autoFocus}
						inputMode="numeric"
						keyboardType="number-pad"
						textContentType="oneTimeCode"
						autoComplete="one-time-code"
						autoCorrect={false}
						caretHidden
						// O cursor fica sempre no fim: tocar numa casinha não deixa editar o meio.
						selection={{ start: value.length, end: value.length }}
						// Folga sobre o número de casinhas para o colar com espaço ou traço ("123 456") chegar inteiro.
						maxLength={maxLength + 8}
						accessibilityLabel={accessibilityLabel}
						// Cobre as casinhas e fica invisível; não some do foco nem do teclado.
						className="absolute inset-0 opacity-0"
						style={{ outlineStyle: "none" } as object}
					/>
				</View>
			</InvalidContext.Provider>
		</SlotsContext.Provider>
	);
}

const InvalidContext = React.createContext(false);

export function InputOTPGroup({ className, ...props }: React.ComponentProps<typeof View>) {
	return <View className={cn("flex-row items-center gap-2", className)} {...props} />;
}

function FakeCaret() {
	const opacity = useSharedValue(1);
	const reduced = useReducedMotion();
	React.useEffect(() => {
		if (reduced) return;
		opacity.value = withRepeat(withSequence(withTiming(0, { duration: 500, easing: Easing.linear }), withTiming(1, { duration: 500, easing: Easing.linear })), -1);
	}, [opacity, reduced]);
	const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
	return <Animated.View style={style} className="h-5 w-0.5 rounded-full bg-foreground" />;
}

export function InputOTPSlot({ index, className }: { index: number; className?: string }) {
	const slot = React.useContext(SlotsContext)[index];
	const invalid = React.useContext(InvalidContext);
	return (
		<View
			className={cn(
				"h-14 w-10 items-center justify-center rounded-2xl border border-transparent bg-input/50",
				invalid && "border-destructive",
				slot?.isActive && !invalid && "border-ring bg-input/70",
				className,
			)}
		>
			{slot?.char ? <Text className="text-xl font-semibold">{slot.char}</Text> : null}
			{slot?.hasFakeCaret ? <FakeCaret /> : null}
		</View>
	);
}

export function InputOTPSeparator({ className }: { className?: string }) {
	return (
		<View role="separator" className={cn("w-4 items-center justify-center", className)}>
			<View className="h-0.5 w-2 rounded-full bg-muted-foreground" />
		</View>
	);
}
