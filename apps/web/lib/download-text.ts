/** Baixa um texto como arquivo pelo navegador (ex.: exportar skill em `.md`). */
export function downloadTextFile(fileName: string, text: string, mime = "text/markdown;charset=utf-8"): void {
	const url = URL.createObjectURL(new Blob([text], { type: mime }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}
