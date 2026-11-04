"use client";

import type { ApprovalField } from "@/lib/owner-wait";

/** Lista legível do que a ação vai fazer ("Para: ana@…", "Assunto: …"), sem nome de ferramenta nem JSON cru. */
export function ApprovalFields({ fields, emptyLabel }: { fields: ApprovalField[]; emptyLabel: string }) {
	if (fields.length === 0) return <p className="m-0 text-body text-muted-foreground">{emptyLabel}</p>;
	return (
		<dl className="m-0 flex min-w-0 flex-col gap-1.5 rounded-card bg-background/70 px-3 py-2 ring-1 ring-foreground/5" data-slot="approval-fields">
			{fields.map((field, index) => (
				<div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3" key={`${field.key}-${index}`}>
					{field.label ? <dt className="shrink-0 text-caption text-muted-foreground sm:w-24 sm:pt-px">{field.label}</dt> : null}
					<dd className="m-0 min-w-0 whitespace-pre-wrap text-body text-foreground [overflow-wrap:anywhere]">{field.value}</dd>
				</div>
			))}
		</dl>
	);
}
