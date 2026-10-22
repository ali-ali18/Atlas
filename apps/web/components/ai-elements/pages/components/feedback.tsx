import type { PageNode } from "@workspace/shared";
import { CircleCheckIcon, InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";

import { calloutTone, TONE_BG, TONE_BORDER, TONE_TEXT, toneStyle } from "./tone";

type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

export function BadgeNode({ node }: { node: Of<"badge"> }) {
	const { text, tone } = node.props;
	return (
		<Badge className={cn("max-w-full border", TONE_BG, TONE_BORDER, TONE_TEXT)} data-page-node="badge" style={toneStyle(tone)} variant="outline">
			{text}
		</Badge>
	);
}

const CALLOUT_ICON = { info: InfoIcon, success: CircleCheckIcon, warning: TriangleAlertIcon, critical: OctagonAlertIcon } as const;

export function CalloutNode({ node }: { node: Of<"callout"> }) {
	const { title, text, tone } = node.props;
	const Icon = CALLOUT_ICON[tone];
	return (
		<Alert className={cn("rounded-xl", TONE_BG, TONE_BORDER)} data-page-node="callout" role="note" style={toneStyle(calloutTone(tone))}>
			<Icon aria-hidden className={TONE_TEXT} />
			{title ? <AlertTitle>{title}</AlertTitle> : null}
			<AlertDescription className="text-foreground/85 [overflow-wrap:anywhere]">{text}</AlertDescription>
		</Alert>
	);
}
