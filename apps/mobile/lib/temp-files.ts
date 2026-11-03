// Arquivos temporários de compartilhar: o destino (no Android, outro app) pode ler o arquivo DEPOIS de a folha do sistema
// voltar, então não se apaga na hora. O nome leva a hora de criação e os antigos são varridos na próxima vez.
import { cacheFileName } from "./document-view";

const PREFIX = "atlas-share-";
/** Quanto um temporário vive antes de a próxima varredura apagar: tempo de sobra para o app de destino ler. */
export const SHARE_TEMP_MAX_AGE_MS = 10 * 60 * 1000;

/** `atlas-share-<epoch>-<nome seguro>`: a hora vai no nome, sem depender de metadado do sistema de arquivos. */
export function shareTempName(filename: string, now: number): string {
	return `${PREFIX}${Math.trunc(now)}-${cacheFileName(filename)}`;
}

/** É um temporário nosso e já passou do prazo (nome de outro arquivo, ou sem hora legível, nunca é apagado). */
export function isStaleShareTemp(name: string, now: number, maxAgeMs = SHARE_TEMP_MAX_AGE_MS): boolean {
	if (!name.startsWith(PREFIX)) return false;
	const stamp = Number(name.slice(PREFIX.length).split("-")[0]);
	if (!Number.isFinite(stamp) || stamp <= 0) return false;
	return now - stamp > maxAgeMs;
}
