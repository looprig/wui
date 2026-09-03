import { describe, expect, it, vi } from "vitest";
import { FactoryRestReads } from "../src/factory-rest.js";
import {
  CoreProtocolError,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "../src/errors.js";

describe("FactoryRestReads bounded object ranges", () => {
  it("issues an authenticated inclusive range request and accepts only a 206 response", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 2-4/9",
          "Content-Length": "3",
          "Content-Type": "application/octet-stream",
        },
      });
    });
    const reads = new FactoryRestReads({
      baseUrl: "https://factory.example/",
      fetch,
      credentials: { restHeaders: () => ({ Authorization: "Bearer object-token" }) },
    });

    await expect(reads.readObjectRange("session /1", "object/a", {
      start: 2, end: 4,
    })).resolves.toEqual({
      bytes: new Uint8Array([2, 3, 4]),
      contentRange: "bytes 2-4/9",
      mediaType: "application/octet-stream",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe("https://factory.example/v1/sessions/session%20%2F1/objects/object%2Fa");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer object-token");
    expect(new Headers(calls[0]?.init?.headers).get("Range")).toBe("bytes=2-4");
  });

  it("rejects one atomically delivered oversized default-reader chunk without another pull", async () => {
    let emittedBytes = 0;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        const chunkBytes = pulls === 1 ? 8 : 4;
        emittedBytes += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const fetch = vi.fn(async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }));
    const reads = new FactoryRestReads({ fetch });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0,
      end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(8);
    expect(pulls).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("returns and cancels at exact fill without pulling one surplus byte", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([pulls]));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(pulls).toBe(4);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("caps a byte stream's BYOB delivery view to the exact remaining range", async () => {
    let pulls = 0;
    let cancelled = false;
    const deliveredViewSizes: number[] = [];
    const byteSource: UnderlyingByteSource = {
      type: "bytes",
      pull(controller) {
        pulls += 1;
        const request = controller.byobRequest;
        if (request?.view === null || request === null) throw new Error("expected a BYOB request");
        deliveredViewSizes.push(request.view.byteLength);
        new Uint8Array(request.view.buffer, request.view.byteOffset, request.view.byteLength)[0] = pulls;
        request.respond(1);
      },
      cancel() { cancelled = true; },
    };
    const body = new ReadableStream(byteSource);
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(deliveredViewSizes).toStrictEqual([4, 3, 2, 1]);
    expect(pulls).toBe(4);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("rejects a legal HTTP 200 Range response before consuming its unproven body", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedBytes += 4;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 200,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(0);
  });

  it("rejects a declared response length above the bound before consuming the body", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedBytes += 8;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4", "Content-Length": "8" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(0);
  });

  it("rejects a declared response length below the exact range before consuming the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(2));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4", "Content-Length": "2" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("rejects Content-Range bounds that differ from the request before consuming the body", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedBytes += 4;
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(0);
  });

  it("rejects a missing 206 body", async () => {
    const reads = new FactoryRestReads({ fetch: async () => new Response(null, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("rejects a body that closes before the exact requested range is filled", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(body.locked).toBe(false);
  });

  it("classifies aborts before and during body reads and cancels the reader", async () => {
    for (const timing of ["before", "during"] as const) {
      const abort = new AbortController();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (timing === "during") abort.abort();
          controller.enqueue(new Uint8Array(4));
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/4" },
      }) });
      if (timing === "before") abort.abort();

      await expect(reads.readObjectRange("session-1", "object-1", {
        start: 0, end: 3, signal: abort.signal,
      })).rejects.toBeInstanceOf(RequestAbortedError);
      expect(cancelled, timing).toBe(true);
    }
  });

  it("awaits asynchronous stream cancellation before releasing an aborted reader", async () => {
    const abort = new AbortController();
    let releaseCancellation!: () => void;
    const cancellationFinished = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    let cancellationStarted = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { queueMicrotask(() => abort.abort()); },
      cancel() {
        cancellationStarted = true;
        return cancellationFinished;
      },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    const result = reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3, signal: abort.signal,
    });
    let settled = false;
    void result.finally(() => { settled = true; }).catch(() => undefined);
    await vi.waitFor(() => expect(cancellationStarted).toBe(true));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCancellation();
    await expect(result).rejects.toBeInstanceOf(RequestAbortedError);
    expect(body.locked).toBe(false);
  });

  it("classifies a body reader failure as a network error and cancels/releases it", async () => {
    let cancelled = false;
    const cause = new Error("reader failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(cause); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toMatchObject({ constructor: NetworkError, cause });
    expect(cancelled).toBe(false); // errored streams are already terminal; cancel remains harmless.
    expect(body.locked).toBe(false);
  });

  // The response bound is DERIVED from the inclusive range, so the only way to
  // ask for an illegal number of bytes is to describe an illegal range. The
  // rows cover: a start that is not a safe integer even though the derived
  // length is (1e-17 rounds away in `end - start + 1`, so the start guard is
  // the SOLE check that rejects it — `{ start: 1.5, end: 3 }` does not isolate
  // it, because 2.5 is not a safe integer either), a non-integer start, a
  // negative start, an end below the start, a non-safe-integer end, and a range
  // whose LENGTH leaves the safe-integer domain even though both endpoints are
  // inside it (0..MAX_SAFE_INTEGER is MAX_SAFE_INTEGER + 1 bytes).
  it.each([
    { start: 1e-17, end: 5 },
    { start: 1.5, end: 3 },
    { start: -1, end: 3 },
    { start: 3, end: 2 },
    { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER + 1 },
    { start: 0, end: Number.MAX_SAFE_INTEGER },
  ])("rejects an invalid byte range before fetch: %o", async (options) => {
    const fetch = vi.fn();
    const reads = new FactoryRestReads({ fetch });
    await expect(reads.readObjectRange("session-1", "object-1", options)).rejects.toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies missing and denied objects identically from Factory's non-disclosing response", async () => {
    const envelope = { error: { code: "not_found", message: "not found", retryable: false } };
    const requests: Array<{ token: string; url: string }> = [];
    const attempt = async (token: string): Promise<CoreProtocolError> => {
      const reads = new FactoryRestReads({
        baseUrl: "https://factory.example",
        credentials: { restHeaders: () => ({ Authorization: token }) },
        fetch: async (url, init) => {
          requests.push({ token: new Headers(init?.headers).get("Authorization") ?? "", url });
          return new Response(JSON.stringify(envelope), { status: 404 });
        },
      });
      try {
        await reads.readObjectMetadata("session-1", "object-1");
        throw new Error("expected read to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CoreProtocolError);
        return error as CoreProtocolError;
      }
    };

    const missing = await attempt("Bearer may-read-missing");
    const denied = await attempt("Bearer denied");
    expect({ code: denied.code, message: denied.message, retryable: denied.retryable, body: denied.body })
      .toStrictEqual({ code: missing.code, message: missing.message, retryable: missing.retryable, body: missing.body });
    expect(requests).toStrictEqual([
      { token: "Bearer may-read-missing", url: "https://factory.example/v1/sessions/session-1/objects/object-1/metadata" },
      { token: "Bearer denied", url: "https://factory.example/v1/sessions/session-1/objects/object-1/metadata" },
    ]);
  });
});
