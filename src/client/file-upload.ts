import { Transport } from "./transport";

export interface FileUploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  metadata?: Record<string, string>;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadedFile {
  id: string;
  userId?: string | null;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  url?: string | null;
  status: "pending" | "completed";
  createdAt: string;
}

export interface PresignedUploadResponse {
  fileId: string;
  uploadUrl: string;
  fields?: Record<string, string>;
  key: string;
  expiresAt: string;
}

export interface FileClient {
  upload(file: File, options?: FileUploadOptions): Promise<UploadedFile>;
  uploadWithPresignedUrl(file: File, options?: FileUploadOptions): Promise<UploadedFile>;
  get(id: string): Promise<UploadedFile>;
  list(options?: FileListOptions): Promise<FileListResponse>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<{ deleted: number }>;
  getDownloadUrl(id: string): string;
}

export interface FileListOptions {
  limit?: number;
  offset?: number;
  filter?: string;
}

export interface FileListResponse {
  data: UploadedFile[];
}

export interface FileClientConfig {
  transport: Transport;
  resourcePath: string;
}

export const createFileClient = (config: FileClientConfig): FileClient => {
  const { transport, resourcePath } = config;

  const upload = async (
    file: File,
    options?: FileUploadOptions
  ): Promise<UploadedFile> => {
    const formData = new FormData();
    formData.append("file", file);

    if (options?.metadata) {
      formData.append("metadata", JSON.stringify(options.metadata));
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (options?.onProgress) {
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            options.onProgress!({
              loaded: event.loaded,
              total: event.total,
              percent: Math.round((event.loaded / event.total) * 100),
            });
          }
        });
      }

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            resolve(response.data as UploadedFile);
          } catch {
            reject(new Error("Invalid response format"));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error?.message || `Upload failed: ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Network error during upload"));
      });

      xhr.addEventListener("abort", () => {
        reject(new Error("Upload aborted"));
      });

      const baseUrl = (transport as unknown as { config: { baseUrl: string } }).config?.baseUrl || "";
      xhr.open("POST", `${baseUrl}${resourcePath}`);

      const headers = (transport as unknown as { headers?: Record<string, string> }).headers;
      if (headers) {
        Object.entries(headers).forEach(([key, value]) => {
          if (key.toLowerCase() !== "content-type") {
            xhr.setRequestHeader(key, value);
          }
        });
      }

      xhr.withCredentials = true;
      xhr.send(formData);
    });
  };

  const uploadWithPresignedUrl = async (
    file: File,
    options?: FileUploadOptions
  ): Promise<UploadedFile> => {
    const params = new URLSearchParams({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    });

    const presignedResponse = await transport.request<{ data: PresignedUploadResponse }>({
      method: "GET",
      path: `${resourcePath}/upload-url`,
      params: Object.fromEntries(params),
    });

    const { fileId, uploadUrl, fields } = presignedResponse.data.data;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (options?.onProgress) {
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            options.onProgress!({
              loaded: event.loaded,
              total: event.total,
              percent: Math.round((event.loaded / event.total) * 100),
            });
          }
        });
      }

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Network error during upload"));
      });

      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

      if (fields) {
        Object.entries(fields).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });
      }

      xhr.send(file);
    });

    const confirmResponse = await transport.request<{ data: UploadedFile }>({
      method: "POST",
      path: `${resourcePath}/${fileId}/confirm`,
    });

    return confirmResponse.data.data;
  };

  const get = async (id: string): Promise<UploadedFile> => {
    const response = await transport.request<{ data: UploadedFile }>({
      method: "GET",
      path: `${resourcePath}/${id}`,
    });
    return response.data.data;
  };

  const list = async (options?: FileListOptions): Promise<FileListResponse> => {
    const params: Record<string, string | number> = {};
    if (options?.limit) params.limit = options.limit;
    if (options?.offset) params.offset = options.offset;
    if (options?.filter) params.filter = options.filter;

    const response = await transport.request<FileListResponse>({
      method: "GET",
      path: resourcePath,
      params,
    });
    return response.data;
  };

  const deleteFile = async (id: string): Promise<void> => {
    await transport.request({
      method: "DELETE",
      path: `${resourcePath}/${id}`,
    });
  };

  const deleteMany = async (ids: string[]): Promise<{ deleted: number }> => {
    const response = await transport.request<{ data: { deleted: number } }>({
      method: "DELETE",
      path: `${resourcePath}/batch`,
      body: { ids },
    });
    return response.data.data;
  };

  const getDownloadUrl = (id: string): string => {
    const baseUrl = (transport as unknown as { config: { baseUrl: string } }).config?.baseUrl || "";
    return `${baseUrl}${resourcePath}/${id}/download`;
  };

  return {
    upload,
    uploadWithPresignedUrl,
    get,
    list,
    delete: deleteFile,
    deleteMany,
    getDownloadUrl,
  };
};
