"use client";

import { Children, Fragment, cloneElement, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";

import { SparklesIcon } from "lucide-react";

import { botAccent, parseSlashSkills, splitGroupMentions } from "@workspace/shared";

import { AppLogo } from "@/components/ai-elements/connectors/app-logo";
import { AgentAvatar } from "../agent-avatar";
import { markdownComponents } from "./assistant-message";

/** Membro do grupo para desenhar a menção. */
export type MentionMember = { id: string; name: string; color?: string; shape?: string; kind?: "bot" | "app"; logo?: string | null };

/** Menção como chip: avatar pequeno + `@Nome` na cor do membro. */
export function MentionChip({ member, text }: { member: MentionMember; text: string }) {
	if (member.kind === "app") {
		// App (conector): chip neutro com a logo pequena (ou a inicial do nome).
		return (
			<span className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[0.92em]" data-slot="app-chip">
				<span className="mr-1 inline-block align-[-0.18em] leading-none">
					<AppLogo className="size-3.5" name={member.name} src={member.logo} />
				</span>
				{text}
			</span>
		);
	}
	const accent = botAccent(member.color)?.accent;
	return (
		<span
			className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[0.92em]"
			data-slot="mention-chip"
			style={accent ? { color: accent } : undefined}
		>
			<span className="mr-1 inline-block align-[-0.18em] leading-none">
				<AgentAvatar animated={false} bodyColor={member.color} id={member.id} shape={member.shape} size={14} />
			</span>
			{text}
		</span>
	);
}

/** `/skill` como chip neutro (sem avatar; o ícone marca que é uma skill). */
export function SkillChip({ text }: { text: string }) {
	return (
		<span className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[0.92em]" data-slot="skill-chip">
			<SparklesIcon aria-hidden className="mr-1 inline-block size-3 align-[-0.12em] text-muted-foreground" />
			{text}
		</span>
	);
}

/** Troca cada `/skill` conhecida do trecho de texto por um chip. */
function renderSkillTokens(text: string, skills: ReadonlySet<string> | undefined): ReactNode {
	if (!skills || skills.size === 0 || !text.includes("/")) return text;
	const tokens = parseSlashSkills(text).filter((token) => skills.has(token.name));
	if (tokens.length === 0) return text;
	const out: ReactNode[] = [];
	let cursor = 0;
	for (const token of tokens) {
		if (token.start > cursor) out.push(<Fragment key={`t${token.start}`}>{text.slice(cursor, token.start)}</Fragment>);
		out.push(<SkillChip key={`s${token.start}`} text={text.slice(token.start, token.end)} />);
		cursor = token.end;
	}
	if (cursor < text.length) out.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
	return out;
}

/**
 * Texto puro com chips no lugar de cada `@Nome` de membro/bot e, quando se passam as
 * skills conhecidas, de cada `/skill`.
 */
export function renderMentions(text: string, members: readonly MentionMember[], skills?: ReadonlySet<string>): ReactNode {
	const parts = splitGroupMentions(text, members);
	if (parts.length === 1 && parts[0]!.type === "text") return renderSkillTokens(text, skills);
	return parts.map((part, index) => {
		if (part.type === "text") return <Fragment key={index}>{renderSkillTokens(part.text, skills)}</Fragment>;
		const member = members.find((item) => item.id === part.botId);
		return member ? <MentionChip key={index} member={member} text={part.text} /> : <Fragment key={index}>{part.text}</Fragment>;
	});
}

/** Aplica os chips às strings filhas (e a elementos de texto simples como negrito/itálico). */
function mapMentions(children: ReactNode, members: readonly MentionMember[]): ReactNode {
	return Children.map(children, (child) => {
		if (typeof child === "string") return renderMentions(child, members);
		if (isValidElement<{ children?: ReactNode }>(child) && (child.type === "strong" || child.type === "em")) {
			return cloneElement(child, undefined, mapMentions(child.props.children, members));
		}
		return child;
	});
}

/** Markdown do balão do bot com chips de menção nos parágrafos, listas e tabelas. */
export function mentionMarkdownComponents(members: readonly MentionMember[]): Components {
	const wrap = (tag: "p" | "li" | "td" | "th"): never => {
		const Base = markdownComponents[tag] as React.ElementType | undefined;
		const Wrapped = ({ node: _node, children, ...props }: { node?: unknown; children?: ReactNode } & Record<string, unknown>) => {
			const mapped = mapMentions(children, members);
			return Base ? <Base {...props}>{mapped}</Base> : <>{mapped}</>;
		};
		return Wrapped as never;
	};
	return { ...markdownComponents, p: wrap("p"), li: wrap("li"), td: wrap("td"), th: wrap("th") };
}
