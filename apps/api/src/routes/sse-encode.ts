export function sseEncode(event: {
	id?: number;
	event?: string;
	data: unknown;
}): string {
	const lines: string[] = [];
	if (event.id !== undefined) lines.push(`id: ${event.id}`);
	if (event.event) lines.push(`event: ${event.event}`);
	lines.push(`data: ${JSON.stringify(event.data)}`);
	return `${lines.join("\n")}\n\n`;
}
