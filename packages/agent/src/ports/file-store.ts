// Porta `FileStore`: arquivos que o bot entrega ao dono. O nome é sanitizado e o caminho montado por quem
// implementa (nunca vem do modelo). Escopada pelo dono.

export type StoredFile = { id: string; name: string; bytes: number; url?: string };

export interface FileStore {
	put(userId: string, file: { name: string; mimeType: string; content: string }): Promise<StoredFile>;
}
