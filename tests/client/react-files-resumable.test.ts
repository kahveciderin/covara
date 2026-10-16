// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => {
  const state = {
    resolve: null as null | ((file: unknown) => void),
    reject: null as null | ((error: unknown) => void),
    options: null as null | Record<string, any>,
    pause: vi.fn(),
    abort: vi.fn(async () => undefined),
    upload: vi.fn(async () => ({ id: "plain" })),
  };
  return state;
});

vi.mock("@/client/file-upload", () => ({
  createFileClient: () => ({
    upload: h.upload,
    uploadWithPresignedUrl: h.upload,
    startResumableUpload: (_file: unknown, options: Record<string, any>) => {
      h.options = options;
      const promise = new Promise((resolve, reject) => {
        h.resolve = resolve;
        h.reject = reject;
      });
      return { promise, uploadId: "up-1", pause: h.pause, abort: h.abort };
    },
  }),
}));

import { useFileUpload } from "@/client/react-files";

describe("useFileUpload (resumable)", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__covaraClient = { transport: {} };
    h.pause.mockClear();
    h.abort.mockClear();
    h.upload.mockClear();
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as Record<string, unknown>).__covaraClient;
  });

  it("drives a resumable upload and exposes progress, uploadId, pause and abort", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useFileUpload({ resourcePath: "/files", resumable: { partSize: 1024 }, onSuccess })
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.upload(new File(["x"], "a.txt"));
    });
    expect(result.current.isUploading).toBe(true);
    expect(h.options?.partSize).toBe(1024);

    act(() => {
      h.options!.onSessionCreated({ uploadId: "up-1" });
      h.options!.onProgress({ loaded: 1, total: 2, percent: 50 });
    });
    expect(result.current.uploadId).toBe("up-1");
    expect(result.current.progress?.percent).toBe(50);

    act(() => result.current.pause());
    expect(h.pause).toHaveBeenCalledTimes(1);

    await act(async () => {
      h.resolve!({ id: "file-1" });
      await pending;
    });
    expect(onSuccess).toHaveBeenCalledWith({ id: "file-1" });
    expect(result.current.isUploading).toBe(false);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("abort() deletes the session through the handle", async () => {
    const { result } = renderHook(() => useFileUpload({ resourcePath: "/files", resumable: true }));
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.upload(new File(["x"], "a.txt")).catch((e) => e);
    });
    await act(async () => {
      await result.current.abort();
      h.reject!(Object.assign(new Error("Upload paused"), { name: "AbortError" }));
      await pending;
    });
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(result.current.uploadId).toBeNull();
  });

  it("uses the plain multipart upload when resumable is off", async () => {
    const { result } = renderHook(() => useFileUpload({ resourcePath: "/files" }));
    await act(async () => {
      await result.current.upload(new File(["x"], "a.txt"));
    });
    expect(h.upload).toHaveBeenCalledTimes(1);
  });
});
