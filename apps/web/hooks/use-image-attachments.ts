"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uploadImage } from "@/lib/atlas-api";

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type ImageAttachment = {
	localId: string;
	file: File;
	previewUrl: string;
	status: "uploading" | "done" | "error";
	artifactId?: string;
	error?: string;
};

export function validateImageFiles(files: readonly File[], existingCount: number): string | null {
	if (files.length + existingCount > MAX_IMAGE_ATTACHMENTS) return "Até 4 imagens por mensagem.";
	for (const file of files) {
		if (!IMAGE_TYPES.has(file.type)) return "Use PNG, JPEG, WebP ou GIF.";
		if (file.size > MAX_IMAGE_BYTES) return "Cada imagem deve ter até 10 MB.";
	}
	return null;
}

async function resizeCameraImage(file: File): Promise<File> {
	if (file.type !== "image/jpeg" && file.type !== "image/png") return file;
	const bitmap = await createImageBitmap(file);
	try {
		const edge = Math.max(bitmap.width, bitmap.height);
		if (edge <= 2048) return file;
		const scale = 2048 / edge;
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
		return blob ? new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }) : file;
	} finally {
		bitmap.close();
	}
}

export function useImageAttachments() {
	const [items, setItems] = useState<ImageAttachment[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [processing, setProcessing] = useState(0);
	const aborts = useRef(new Map<string, AbortController>());
	const previewUrls = useRef(new Map<string, string>());
	const reservedCount = useRef(0);
	const generation = useRef(0);

	const remove = useCallback((localId: string) => {
		aborts.current.get(localId)?.abort();
		aborts.current.delete(localId);
		const url = previewUrls.current.get(localId);
		if (url) URL.revokeObjectURL(url);
		previewUrls.current.delete(localId);
		reservedCount.current = Math.max(0, reservedCount.current - 1);
		setItems((previous) => {
			return previous.filter((entry) => entry.localId !== localId);
		});
	}, []);

	const clear = useCallback(() => {
		generation.current += 1;
		for (const controller of aborts.current.values()) controller.abort();
		aborts.current.clear();
		for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
		previewUrls.current.clear();
		reservedCount.current = 0;
		setItems([]);
		setError(null);
	}, []);

	useEffect(() => () => {
		generation.current += 1;
		for (const controller of aborts.current.values()) controller.abort();
		for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
		previewUrls.current.clear();
	}, []);

	const addFiles = useCallback(async (files: FileList | File[], camera = false) => {
		const chosen = Array.from(files);
		const validation = validateImageFiles(chosen, reservedCount.current);
		if (validation) { setError(validation); return; }
		reservedCount.current += chosen.length;
		const currentGeneration = generation.current;
		setError(null);
		setProcessing((count) => count + 1);
		try {
		for (const original of chosen) {
			const file = camera ? await resizeCameraImage(original).catch(() => original) : original;
			if (currentGeneration !== generation.current) return;
			const localId = crypto.randomUUID();
			const previewUrl = URL.createObjectURL(file);
			previewUrls.current.set(localId, previewUrl);
			const controller = new AbortController();
			aborts.current.set(localId, controller);
			setItems((previous) => [...previous, { localId, file, previewUrl, status: "uploading" }]);
			void uploadImage(file, controller.signal).then((uploaded) => {
				if (controller.signal.aborted) return;
				setItems((previous) => previous.map((item) => item.localId === localId
					? { ...item, status: "done", artifactId: uploaded.id } : item));
			}).catch((failure: unknown) => {
				if (controller.signal.aborted) return;
				setItems((previous) => previous.map((item) => item.localId === localId
					? { ...item, status: "error", error: failure instanceof Error ? failure.message : "Falha no upload" } : item));
			}).finally(() => aborts.current.delete(localId));
		}
		} finally { setProcessing((count) => count - 1); }
	}, []);

	return { items, error, addFiles, remove, clear, ready: items.filter((item) => item.status === "done" && item.artifactId).map((item) => ({ artifactId: item.artifactId! })), uploading: processing > 0 || items.some((item) => item.status === "uploading") };
}
