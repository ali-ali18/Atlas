/** Imagens são sempre servidas pela API autenticada na mesma origem. */
export function imageFileUrl(id: string, download = false): string {
	return `/v1/files/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}
