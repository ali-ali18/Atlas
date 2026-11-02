import * as React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { themeColor, type ColorToken } from "@/lib/theme";
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

type LineIconProps = IconProps & { tone?: ColorToken };

function useStroke(tone: ColorToken) {
	return themeColor(useAppColorScheme(), tone);
}

function Line({ size, tone, strokeWidth = 2, children }: LineIconProps & { strokeWidth?: number; children: React.ReactNode }) {
	const stroke = useStroke(tone ?? "foreground");
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
			{children}
		</Svg>
	);
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


/** Lucide `Plus`. */
export function PlusIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="M5 12h14" />
			<Path d="M12 5v14" />
		</Line>
	);
}

/** Lucide `Search`. */
export function SearchIcon({ size = 20, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Circle cx={11} cy={11} r={8} />
			<Path d="m21 21-4.3-4.3" />
		</Line>
	);
}

/** Lucide `ChevronDown`. */
export function ChevronDownIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="m6 9 6 6 6-6" />
		</Line>
	);
}

/** Lucide `Send` (avião de papel): a prévia "Enviou mensagem para…". */
export function SendIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
			<Path d="m21.854 2.147-10.94 10.939" />
		</Line>
	);
}

/** Lucide `LayoutGrid` com um "+" no lugar do quarto quadrado (o botão de apps do rodapé). */
export function GridPlusIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Rect width={7} height={7} x={3} y={3} rx={1} />
			<Rect width={7} height={7} x={14} y={3} rx={1} />
			<Rect width={7} height={7} x={3} y={14} rx={1} />
			<Path d="M14 17.5h7" />
			<Path d="M17.5 14v7" />
		</Line>
	);
}

/** Lucide `ChevronLeft`. */
export function ChevronLeftIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="m15 18-6-6 6-6" />
		</Line>
	);
}

/** Lucide `Star` preenchida (selo do bot principal). */
export function StarFilledIcon({ size = 14, color = "#ffffff" }: IconProps & { color?: string }) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth={2} strokeLinejoin="round">
			<Path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
		</Svg>
	);
}

/** Lucide `Ellipsis`. */
export function DotsIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Circle cx={12} cy={12} r={1} />
			<Circle cx={19} cy={12} r={1} />
			<Circle cx={5} cy={12} r={1} />
		</Line>
	);
}

/** Lucide `Mic`. */
export function MicIcon({ size = 20, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="M12 19v3" />
			<Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
			<Rect x={9} y={2} width={6} height={13} rx={3} />
		</Line>
	);
}

/** Lucide `ArrowUp` (enviar). */
export function ArrowUpIcon({ size = 20, color = "#ffffff" }: IconProps & { color?: string }) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
			<Path d="m5 12 7-7 7 7" />
			<Path d="M12 19V5" />
		</Svg>
	);
}

/** Quadrado cheio (parar). */
export function StopIcon({ size = 16, color = "#ffffff" }: IconProps & { color?: string }) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
			<Rect x={5} y={5} width={14} height={14} rx={3} />
		</Svg>
	);
}

/** Lucide `AudioLines` (voz, o botão colorido do composer). */
export function WaveformIcon({ size = 20, color = "#ffffff" }: IconProps & { color?: string }) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
			<Path d="M2 10v3" />
			<Path d="M6 6v11" />
			<Path d="M10 3v18" />
			<Path d="M14 8v7" />
			<Path d="M18 5v13" />
			<Path d="M22 10v3" />
		</Svg>
	);
}

/** Lucide `CircleUserRound`. */
export function UserCircleIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="M18 20a6 6 0 0 0-12 0" />
			<Circle cx={12} cy={10} r={4} />
			<Circle cx={12} cy={12} r={10} />
		</Line>
	);
}

/** Lucide `Share` (caixa com seta para cima). */
export function ShareIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="M12 2v13" />
			<Path d="m16 6-4-4-4 4" />
			<Path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
		</Line>
	);
}

/** Lucide `ChevronRight`. */
export function ChevronRightIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="m9 18 6-6-6-6" />
		</Line>
	);
}

/** Lucide `ChevronUp`. */
export function ChevronUpIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="m18 15-6-6-6 6" />
		</Line>
	);
}

/** Lucide `CircleCheck`. */
export function CheckCircleIcon({ size = 16, tone = "success" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Circle cx={12} cy={12} r={10} />
			<Path d="m9 12 2 2 4-4" />
		</Line>
	);
}

/** Lucide `Circle`. */
export function CircleIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Circle cx={12} cy={12} r={10} />
		</Line>
	);
}

/** Lucide `ListChecks`. */
export function ListChecksIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="m3 17 2 2 4-4" />
			<Path d="m3 7 2 2 4-4" />
			<Path d="M13 6h8" />
			<Path d="M13 12h8" />
			<Path d="M13 18h8" />
		</Line>
	);
}

/** Lucide `ExternalLink`. */
export function ExternalLinkIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="M15 3h6v6" />
			<Path d="M10 14 21 3" />
			<Path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</Line>
	);
}

/** Lucide `CodeXml` (Programação). */
export function CodeIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Path d="m18 16 4-4-4-4" />
			<Path d="m6 8-4 4 4 4" />
			<Path d="m14.5 4-5 16" />
		</Line>
	);
}

/** Lucide `Clock` (Rotinas). */
export function ClockIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Circle cx={12} cy={12} r={10} />
			<Path d="M12 6v6l4 2" />
		</Line>
	);
}

/** Lucide `LibraryBig` (Biblioteca). */
export function LibraryIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Rect x={3} y={3} width={8} height={18} rx={1} />
			<Path d="M7 3v18" />
			<Path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z" />
		</Line>
	);
}

/** Lucide `Monitor` (Computador). */
export function MonitorIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return (
		<Line size={size} tone={tone}>
			<Rect x={2} y={3} width={20} height={14} rx={2} />
			<Path d="M8 21h8" />
			<Path d="M12 17v4" />
		</Line>
	);
}
