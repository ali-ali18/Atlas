import Svg, { Circle, Path } from "react-native-svg";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

type IconProps = { size?: number };

/** Portado de apps/web/components/icons/social.tsx (cores da marca, iguais ao web). */
export function GoogleIcon({ size = 18 }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
			<Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" fill="#4285F4" />
			<Path d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" fill="#34A853" />
			<Path d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.07H2.18a11 11 0 0 0 0 9.87l3.66-2.83Z" fill="#FBBC05" />
			<Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.07l3.66 2.82c.87-2.6 3.3-4.51 6.16-4.51Z" fill="#EA4335" />
		</Svg>
	);
}

type LineIconProps = IconProps & { tone?: "muted-foreground" | "foreground" };

function useStroke(tone: "muted-foreground" | "foreground") {
	return themeColor(useAppColorScheme(), tone);
}

/** Lucide `AtSign` (o ícone do campo de e-mail no login do web). */
export function AtSignIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	const stroke = useStroke(tone);
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
			<Circle cx={12} cy={12} r={4} />
			<Path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
		</Svg>
	);
}

/** Lucide `Link` (o campo do endereço do servidor usa no lugar do AtSign). */
export function LinkIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	const stroke = useStroke(tone);
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
			<Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
			<Path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
		</Svg>
	);
}

/** Lucide `Hash` (campo do código de 6 números). */
export function HashIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	const stroke = useStroke(tone);
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
			<Path d="M4 9h16" />
			<Path d="M4 15h16" />
			<Path d="M10 3 8 21" />
			<Path d="m16 3-2 18" />
		</Svg>
	);
}
