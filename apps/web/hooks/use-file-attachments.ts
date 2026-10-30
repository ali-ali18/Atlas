"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ATTACHMENT_LIMITS } from "@workspace/shared";
import { uploadFileAttachment } from "@/lib/atlas-api";
import { activeT } from "@/lib/i18n/active";

export const MAX_FILE_ATTACHMENTS = ATTACHMENT_LIMITS.maxPerMessage;
export const MAX_FILE_BYTES = ATTACHMENT_LIMITS.maxBytes;

/** O que o composer entrega a `onSend`: imagem só com id; arquivo também leva o que o cartão otimista mostra. */
export type OutgoingAttachment = { artifactId: string; file?: { name: string; mime: string; size: number } };

export type FileAttachment = {
	localId: string;
	file: File;
	status: "uploading" | "done" | "error";
	artifactId?: string;
	error?: string;
};

/** Imagens seguem pelo anexo de imagem; o resto (qualquer tipo) vira anexo de arquivo. */
export function isImageFile(file: File): boolean {
	return file.type.startsWith("image/");
}

export function validateAttachmentFiles(files: readonly File[], existingCount: number): string | null {
	if (files.length + existingCount > MAX_FILE_ATTACHMENTS) return activeT("errors.maxFiles", { count: MAX_FILE_ATTACHMENTS });
	for (const file of files) {
		if (file.size === 0) return activeT("errors.fileEmpty", { name: file.name });
		if (file.size > MAX_FILE_BYTES) return activeT("errors.fileTooBig");
	}
	return null;
}

export function useFileAttachments() {
	const [items, setItems] = useState<FileAttachment[]>([]);
	const [error, setError] = useState<string | null>(null);
	const aborts = useRef(new Map<string, AbortController>());
	const reservedCount = useRef(0);

	const remove = useCallback((localId: string) => {
		aborts.current.get(localId)?.abort();
		aborts.current.delete(localId);
		reservedCount.current = Math.max(0, reservedCount.current - 1);
		setItems((previous) => previous.filter((entry) => entry.localId !== localId));
		setError(null);
	}, []);

	const clear = useCallback(() => {
		for (const controller of aborts.current.values()) controller.abort();
		aborts.current.clear();
		reservedCount.current = 0;
		setItems([]);
		setError(null);
	}, []);

	useEffect(() => () => {
		for (const controller of aborts.current.values()) controller.abort();
	}, []);

	const addFiles = useCallback((files: FileList | File[]) => {
		const chosen = Array.from(files);
		if (chosen.length === 0) return;
		const validation = validateAttachmentFiles(chosen, reservedCount.current);
		if (validation) { setError(validation); return; }
		reservedCount.current += chosen.length;
		setError(null);
		for (const file of chosen) {
			const localId = crypto.randomUUID();
			const controller = new AbortController();
			aborts.current.set(localId, controller);
			setItems((previous) => [...previous, { localId, file, status: "uploading" }]);
			void uploadFileAttachment(file, controller.signal).then((uploaded) => {
				if (controller.signal.aborted) return;
				setItems((previous) => previous.map((item) => item.localId === localId ? { ...item, status: "done", artifactId: uploaded.id } : item));
			}).catch((failure: unknown) => {
				if (controller.signal.aborted) return;
				setItems((previous) => previous.map((item) => item.localId === localId
					? { ...item, status: "error", error: failure instanceof Error ? failure.message : activeT("errors.uploadFailed") } : item));
			}).finally(() => aborts.current.delete(localId));
		}
	}, []);

	return {
		items,
		error,
		addFiles,
		remove,
		clear,
		ready: items
			.filter((item) => item.status === "done" && item.artifactId)
			.map((item) => ({ artifactId: item.artifactId!, file: { name: item.file.name, mime: item.file.type, size: item.file.size } })),
		uploading: items.some((item) => item.status === "uploading"),
		hasError: items.some((item) => item.status === "error"),
	};
}
