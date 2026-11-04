import * as React from "react";
import {
	ArrowUp as LucideArrowUp,
	AtSign as LucideAtSign,
	AudioLines as LucideAudioLines,
	ChevronDown as LucideChevronDown,
	ChevronLeft as LucideChevronLeft,
	ChevronRight as LucideChevronRight,
	ChevronUp as LucideChevronUp,
	ChevronsDownUp as LucideChevronsDownUp,
	ChevronsUpDown as LucideChevronsUpDown,
	Circle as LucideCircle,
	CircleCheck as LucideCircleCheck,
	Check as LucideCheck,
	CircleUserRound as LucideCircleUserRound,
	Clock as LucideClock,
	CodeXml as LucideCodeXml,
	Copy as LucideCopy,
	Download as LucideDownload,
	Ellipsis as LucideEllipsis,
	ExternalLink as LucideExternalLink,
	File as LucideFile,
	Forward as LucideForward,
	FileSpreadsheet as LucideFileSpreadsheet,
	FileText as LucideFileText,
	Image as LucideImage,
	LayoutDashboard as LucideLayoutDashboard,
	Presentation as LucidePresentation,
	Hash as LucideHash,
	LibraryBig as LucideLibraryBig,
	Link as LucideLink,
	MailOpen as LucideMailOpen,
	ListChecks as LucideListChecks,
	Mic as LucideMic,
	Monitor as LucideMonitor,
	MousePointer2 as LucideMousePointer2,
	Pencil as LucidePencil,
	Pin as LucidePin,
	PinOff as LucidePinOff,
	FolderInput as LucideFolderInput,
	FolderOutput as LucideFolderOutput,
	Plus as LucidePlus,
	Reply as LucideReply,
	Search as LucideSearch,
	SlidersHorizontal as LucideSlidersHorizontal,
	Sparkles as LucideSparkles,
	Send as LucideSend,
	Share as LucideShare,
	Square as LucideSquare,
	Star as LucideStar,
	TextCursorInput as LucideTextCursorInput,
	UserRoundCog as LucideUserRoundCog,
	UserRoundPlus as LucideUserRoundPlus,
	X as LucideX,
	ClipboardPaste as LucideClipboardPaste,
	CircleHelp as LucideCircleHelp,
	Keyboard as LucideKeyboard,
} from "lucide-react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { themeColor, type ColorToken } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// Ícones do Lucide pelo `lucide-react-native`: os mesmos desenhos e o mesmo traço (2) do `lucide-react` do web, em
// vez de cópias à mão dos caminhos. Os nomes e as props daqui ficam iguais para os chamadores não mudarem.

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

/** Traço do Lucide para o ícone composto abaixo (sem equivalente no Lucide). */
function Line({ size, tone, strokeWidth = 2, children }: LineIconProps & { strokeWidth?: number; children: React.ReactNode }) {
	const stroke = useStroke(tone ?? "foreground");
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
			{children}
		</Svg>
	);
}


/** Lucide `AtSign` (o campo de e-mail no login do web). */
export function AtSignIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return <LucideAtSign size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Link` (o campo do endereço do servidor). */
export function LinkIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return <LucideLink size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Plus`. */
export function PlusIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return <LucidePlus size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Search`. */
export function SearchIcon({ size = 20, tone = "muted-foreground" }: LineIconProps) {
	return <LucideSearch size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ChevronDown`. */
export function ChevronDownIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return <LucideChevronDown size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Send` (a prévia "Enviou mensagem para…"). */
export function SendIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideSend size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ChevronLeft`. */
export function ChevronLeftIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return <LucideChevronLeft size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Ellipsis`. */
export function DotsIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return <LucideEllipsis size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `MousePointer2` (seta de cursor). Cor fixa: o menu do Computador é sempre escuro. */
export function CursorIcon({ size = 22, color = "#a1a1aa" }: IconProps & { color?: string }) {
	return <LucideMousePointer2 size={size} color={color} strokeWidth={2} />;
}

/** Lucide `Check`. Cor fixa, como `CursorIcon`. */
export function CheckOnDarkIcon({ size = 20, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideCheck size={size} color={color} strokeWidth={2} />;
}

/** Lucide `Mic`. */
export function MicIcon({ size = 20, tone = "muted-foreground" }: LineIconProps) {
	return <LucideMic size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `CircleUserRound`. */
export function UserCircleIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return <LucideCircleUserRound size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Share`. */
export function ShareIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return <LucideShare size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ChevronRight`. */
export function ChevronRightIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return <LucideChevronRight size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ChevronUp`. */
export function ChevronUpIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return <LucideChevronUp size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `CircleCheck`. */
export function CheckCircleIcon({ size = 16, tone = "success" }: LineIconProps) {
	return <LucideCircleCheck size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Circle`. */
export function CircleIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideCircle size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ListChecks`. */
export function ListChecksIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideListChecks size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ExternalLink`. */
export function ExternalLinkIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideExternalLink size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `CodeXml` (Programação). */
export function CodeIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return <LucideCodeXml size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Clock` (Rotinas). */
export function ClockIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return <LucideClock size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `LibraryBig` (Biblioteca). */
export function LibraryIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return <LucideLibraryBig size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Monitor` (Computador). */
export function MonitorIcon({ size = 22, tone = "muted-foreground" }: LineIconProps) {
	return <LucideMonitor size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Pencil`. */
export function PencilIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucidePencil size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Check` (item marcado numa lista). */
export function CheckIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideCheck size={size} color={useStroke(tone)} strokeWidth={2.25} />;
}

/** Lucide `SlidersHorizontal` (o seletor de modelo no composer). */
export function SlidersIcon({ size = 18, tone = "foreground" }: LineIconProps) {
	return <LucideSlidersHorizontal size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ChevronsUpDown` (seletor). */
export function ChevronUpDownIcon({ size = 18, tone = "muted-foreground" }: LineIconProps) {
	return <LucideChevronsUpDown size={size} color={useStroke(tone)} strokeWidth={2} />;
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

/** Lucide `Star` preenchida (selo do bot principal). */
export function StarFilledIcon({ size = 14, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideStar size={size} color={color} fill={color} strokeWidth={2} />;
}

/** Lucide `ArrowUp` (enviar). */
export function ArrowUpIcon({ size = 20, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideArrowUp size={size} color={color} strokeWidth={2} />;
}

/** Lucide `Square` preenchido (parar), como o `SquareIcon className="fill-current"` do web. */
export function StopIcon({ size = 16, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideSquare size={size} color={color} fill={color} strokeWidth={2} />;
}

/** Lucide `AudioLines` (voz, o botão colorido do composer). */
export function WaveformIcon({ size = 20, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideAudioLines size={size} color={color} strokeWidth={2} />;
}

/** Lucide `Copy` (menu da mensagem: Copiar). */
export function CopyIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideCopy size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `TextCursorInput` (menu da mensagem: Selecionar texto). */
export function TextSelectIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideTextCursorInput size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Hash` (menu da mensagem: Copiar ID da solicitação). */
export function HashIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideHash size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `MailOpen` (menu da mensagem: Marcar como não lida). */
export function MailOpenIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideMailOpen size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Reply` (menu da mensagem: Responder). */
export function ReplyIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideReply size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Sparkles` (a habilidade: o mesmo ícone do web nos chips e na lista do `/`). */
export function SparklesIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideSparkles size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ChevronsDownUp`: o comando `/compact` (comprimir a conversa). */
export function CompactIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideChevronsDownUp size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `X`. */
export function CloseIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideX size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Pin` (menu da conversa: Fixar). */
export function PinIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucidePin size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `PinOff` (menu da conversa: Desafixar). */
export function PinOffIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucidePinOff size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `FolderInput` (menu da conversa: Mover para). */
export function FolderInputIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideFolderInput size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `FolderOutput` (menu da conversa: Tirar da seção). */
export function FolderOutputIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideFolderOutput size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `ClipboardPaste` (Colar no computador). Cor fixa: a tela do Computador é sempre escura. */
export function ClipboardPasteIcon({ size = 22, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideClipboardPaste size={size} color={color} strokeWidth={2} />;
}

/** Lucide `Keyboard`. */
export function KeyboardIcon({ size = 22, color = "#ffffff" }: IconProps & { color?: string }) {
	return <LucideKeyboard size={size} color={color} strokeWidth={2} />;
}

/** Lucide `CircleHelp` (o "?" do topo). */
export function HelpIcon({ size = 22, tone = "foreground" }: LineIconProps) {
	return <LucideCircleHelp size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `LayoutDashboard` (Painel, na Biblioteca). */
export function LayoutDashboardIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideLayoutDashboard size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `FileText` (Documento). */
export function FileTextIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideFileText size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `FileSpreadsheet` (Planilha). */
export function FileSpreadsheetIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideFileSpreadsheet size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Presentation` (Apresentação). */
export function PresentationIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucidePresentation size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Image` (Imagem). */
export function ImageIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideImage size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `File` (Arquivo sem tipo conhecido). */
export function FileIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideFile size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Forward` (visualizador de imagens: Encaminhar). */
export function ForwardIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideForward size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `Download` (visualizador de imagens: Salvar). */
export function DownloadIcon({ size = 20, tone = "foreground" }: LineIconProps) {
	return <LucideDownload size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `UserRoundPlus` (o cartão "Criar agente"). */
export function UserPlusIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideUserRoundPlus size={size} color={useStroke(tone)} strokeWidth={2} />;
}

/** Lucide `UserRoundCog` (o cartão de perfil do bot). */
export function UserCogIcon({ size = 16, tone = "muted-foreground" }: LineIconProps) {
	return <LucideUserRoundCog size={size} color={useStroke(tone)} strokeWidth={2} />;
}
