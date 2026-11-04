// Parte de multipart para um arquivo local, no formato que o `expo/fetch` do SDK 58 aceita (ele rejeita `{ uri }`).
// Lê os bytes do disco com o `File` do expo-file-system só na hora de montar o corpo. Fica à parte de `upload-api.ts`
// porque importa o módulo nativo, que o vitest não carrega.
// `File` não estende `Blob` (só o implementa) e o nome da parte sairia do último trecho do uri; por isso a parte leva o
// `name` e o `type` do anexo (extensão certa: o servidor classifica por nome + conteúdo) e delega só `bytes()`.
// `content://` (Android) é aceito pelo expo-file-system, que lê via ContentResolver.
import { File } from "expo-file-system";
import type { BlobPart, UploadInput } from "./upload-api";

export function filePart(input: UploadInput): BlobPart {
	const file = new File(input.uri);
	return { name: input.name, type: input.mime, bytes: () => file.bytes() };
}
