import { useState, useCallback, useMemo, useRef } from "react";
import { getClient } from "./globals";
import {
  createFileClient,
  FileUploadOptions,
  UploadedFile,
  UploadProgress,
  FileListOptions,
} from "./file-upload";

export interface UseFileUploadOptions {
  resourcePath: string;
  usePresignedUrl?: boolean;
  onSuccess?: (file: UploadedFile) => void;
  onError?: (error: Error) => void;
}

export interface UseFileUploadResult {
  upload: (file: File, options?: Omit<FileUploadOptions, "onProgress">) => Promise<UploadedFile>;
  isUploading: boolean;
  progress: UploadProgress | null;
  error: Error | null;
  reset: () => void;
}

export function useFileUpload(options: UseFileUploadOptions): UseFileUploadResult {
  const { resourcePath, usePresignedUrl = false, onSuccess, onError } = options;

  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const fileClient = useMemo(() => {
    const client = getClient();
    return createFileClient({
      transport: client.transport as Parameters<typeof createFileClient>[0]["transport"],
      resourcePath,
    });
  }, [resourcePath]);

  const upload = useCallback(
    async (file: File, uploadOptions?: Omit<FileUploadOptions, "onProgress">) => {
      setIsUploading(true);
      setProgress(null);
      setError(null);

      try {
        const uploadFn = usePresignedUrl
          ? fileClient.uploadWithPresignedUrl
          : fileClient.upload;

        const result = await uploadFn(file, {
          ...uploadOptions,
          onProgress: setProgress,
        });

        onSuccess?.(result);
        return result;
      } catch (err) {
        const uploadError = err instanceof Error ? err : new Error(String(err));
        setError(uploadError);
        onError?.(uploadError);
        throw uploadError;
      } finally {
        setIsUploading(false);
      }
    },
    [fileClient, usePresignedUrl, onSuccess, onError]
  );

  const reset = useCallback(() => {
    setIsUploading(false);
    setProgress(null);
    setError(null);
  }, []);

  return {
    upload,
    isUploading,
    progress,
    error,
    reset,
  };
}

export interface UseFileOptions {
  resourcePath: string;
}

export interface UseFileResult {
  file: UploadedFile | null;
  isLoading: boolean;
  error: Error | null;
  fetch: (id: string) => Promise<void>;
  /** Open the file download in a new browser tab. Only works in browser environments. */
  download: () => void;
  /** Get the download URL. Useful for React Native with Linking.openURL(). */
  getDownloadUrl: () => string | null;
  deleteFile: () => Promise<void>;
}

export function useFile(
  fileId: string | null,
  options: UseFileOptions
): UseFileResult {
  const { resourcePath } = options;

  const [file, setFile] = useState<UploadedFile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fileClient = useMemo(() => {
    const client = getClient();
    return createFileClient({
      transport: client.transport as Parameters<typeof createFileClient>[0]["transport"],
      resourcePath,
    });
  }, [resourcePath]);

  const fetch = useCallback(
    async (id: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await fileClient.get(id);
        setFile(result);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    },
    [fileClient]
  );

  /**
   * Get the download URL for the file. Useful for React Native where
   * you need to handle downloads differently (e.g., with Linking or a download manager).
   */
  const getDownloadUrl = useCallback(() => {
    return fileId ? fileClient.getDownloadUrl(fileId) : null;
  }, [fileClient, fileId]);

  /**
   * Open the file download in a new browser tab. Only works in browser environments.
   * For React Native, use getDownloadUrl() with Linking.openURL().
   */
  const download = useCallback(() => {
    if (fileId) {
      const url = fileClient.getDownloadUrl(fileId);
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(url, "_blank");
      } else {
        console.warn(
          "window.open is not available. Use getDownloadUrl() with Linking.openURL() for React Native."
        );
      }
    }
  }, [fileClient, fileId]);

  const deleteFile = useCallback(async () => {
    if (!fileId) return;

    try {
      await fileClient.delete(fileId);
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }, [fileClient, fileId]);

  return {
    file,
    isLoading,
    error,
    fetch,
    download,
    getDownloadUrl,
    deleteFile,
  };
}

export interface UseFilesOptions extends FileListOptions {
  resourcePath: string;
  autoFetch?: boolean;
}

export interface UseFilesResult {
  files: UploadedFile[];
  isLoading: boolean;
  error: Error | null;
  fetch: () => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  deleteMany: (ids: string[]) => Promise<void>;
  getDownloadUrl: (id: string) => string;
}

export function useFiles(options: UseFilesOptions): UseFilesResult {
  const { resourcePath, autoFetch = true, ...listOptions } = options;

  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hasFetched = useRef(false);

  const fileClient = useMemo(() => {
    const client = getClient();
    return createFileClient({
      transport: client.transport as Parameters<typeof createFileClient>[0]["transport"],
      resourcePath,
    });
  }, [resourcePath]);

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fileClient.list(listOptions);
      setFiles(result.data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [fileClient, JSON.stringify(listOptions)]);

  if (autoFetch && !hasFetched.current) {
    hasFetched.current = true;
    fetch();
  }

  const deleteFile = useCallback(
    async (id: string) => {
      await fileClient.delete(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
    },
    [fileClient]
  );

  const deleteMany = useCallback(
    async (ids: string[]) => {
      await fileClient.deleteMany(ids);
      setFiles((prev) => prev.filter((f) => !ids.includes(f.id)));
    },
    [fileClient]
  );

  const getDownloadUrl = useCallback(
    (id: string) => fileClient.getDownloadUrl(id),
    [fileClient]
  );

  return {
    files,
    isLoading,
    error,
    fetch,
    deleteFile,
    deleteMany,
    getDownloadUrl,
  };
}

export type { UploadedFile, UploadProgress, FileUploadOptions } from "./file-upload";
