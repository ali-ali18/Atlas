export function truncateSnippet(content: string, max = 300): string {
	const normalized = content.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
