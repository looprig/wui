import {
  errorFromCoreEnvelope,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "./errors.js";
import type {
  DepartmentCapabilitySummary,
  FactorySessionStatus,
  ObjectMetadata,
  PublicGatePage,
  PublicJournalPage,
  RecentSessionPage,
} from "./types.js";
import {
  validateDepartmentCapabilitySummary,
  validateCoreErrorEnvelope,
  validateFactorySessionStatus,
  validateObjectMetadata,
  validatePublicGatePage,
  validatePublicJournalPage,
  validateRecentSessionPage,
} from "./validate.js";
import type { FetchLike, RequestOptions } from "./transport.js";

export interface FactoryRestCredentials {
  restHeaders?(): Promise<Record<string, string>> | Record<string, string>;
}

export interface FactoryPageOptions extends RequestOptions {
  cursor?: string;
  limit?: number;
}

export interface FactoryJournalOptions extends FactoryPageOptions {
  /** A bounded tail-first read. Mutually exclusive with cursor. */
  tail?: number;
}

export interface ObjectRangeOptions extends RequestOptions {
  start: number;
  end: number;
}

export interface ObjectRange {
  bytes: Uint8Array;
  contentRange: string;
  mediaType: string | undefined;
}

export interface FactoryReads {
  listAgents(options?: FactoryPageOptions): Promise<DepartmentCapabilitySummary>;
  listRecentSessions(options?: FactoryPageOptions): Promise<RecentSessionPage>;
  readStatus(sessionId: string, options?: RequestOptions): Promise<FactorySessionStatus>;
  readJournal(sessionId: string, options?: FactoryJournalOptions): Promise<PublicJournalPage>;
  listGates(sessionId: string, options?: FactoryPageOptions): Promise<PublicGatePage>;
  readObjectMetadata(sessionId: string, objectId: string, options?: RequestOptions): Promise<ObjectMetadata>;
  readObjectRange(sessionId: string, objectId: string, options: ObjectRangeOptions): Promise<ObjectRange>;
}

export interface FactoryRestOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  credentials?: FactoryRestCredentials;
}

function query(options: FactoryPageOptions & { tail?: number }): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.tail !== undefined) params.set("tail", String(options.tail));
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function normalizedBase(baseUrl: string | undefined): string {
  return baseUrl === undefined ? "" : baseUrl.replace(/\/+$/, "");
}

export class FactoryRestReads implements FactoryReads {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly credentials: FactoryRestCredentials;

  constructor(options: FactoryRestOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = normalizedBase(options.baseUrl);
    this.credentials = options.credentials ?? {};
  }

  async listAgents(options: FactoryPageOptions = {}): Promise<DepartmentCapabilitySummary> {
    return validateDepartmentCapabilitySummary(
      await this.getJSON(`/v1/agents${query(options)}`, options.signal),
    );
  }

  async listRecentSessions(options: FactoryPageOptions = {}): Promise<RecentSessionPage> {
    return validateRecentSessionPage(await this.getJSON(`/v1/sessions${query(options)}`, options.signal));
  }

  async readStatus(sessionId: string, options: RequestOptions = {}): Promise<FactorySessionStatus> {
    return validateFactorySessionStatus(
      await this.getJSON(`/v1/sessions/${encodeURIComponent(sessionId)}/status`, options.signal),
    );
  }

  async readJournal(sessionId: string, options: FactoryJournalOptions = {}): Promise<PublicJournalPage> {
    if (options.cursor !== undefined && options.tail !== undefined) {
      throw new RangeError("journal cursor and tail are mutually exclusive");
    }
    return validatePublicJournalPage(
      await this.getJSON(`/v1/sessions/${encodeURIComponent(sessionId)}/journal${query(options)}`, options.signal),
    );
  }

  async listGates(sessionId: string, options: FactoryPageOptions = {}): Promise<PublicGatePage> {
    return validatePublicGatePage(
      await this.getJSON(`/v1/sessions/${encodeURIComponent(sessionId)}/gates${query(options)}`, options.signal),
    );
  }

  async readObjectMetadata(
    sessionId: string,
    objectId: string,
    options: RequestOptions = {},
  ): Promise<ObjectMetadata> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(objectId)}/metadata`;
    return validateObjectMetadata(await this.getJSON(path, options.signal));
  }

  async readObjectRange(sessionId: string, objectId: string, options: ObjectRangeOptions): Promise<ObjectRange> {
    if (!Number.isSafeInteger(options.start) || !Number.isSafeInteger(options.end) || options.start < 0 || options.end < options.start) {
      throw new RangeError("object range must be non-negative safe integers with end >= start");
    }
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(objectId)}`;
    const response = await this.request(path, {
      method: "GET",
      signal: options.signal,
      headers: { Range: `bytes=${options.start}-${options.end}` },
    });
    if (!response.ok) await this.throwResponseError(path, response);
    const contentRange = response.headers.get("Content-Range");
    if (response.status !== 206 || contentRange === null) {
      throw new MalformedResponseError(path, response.status);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentRange,
      mediaType: response.headers.get("Content-Type") ?? undefined,
    };
  }

  private async getJSON(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, { method: "GET", signal });
    if (!response.ok) await this.throwResponseError(path, response);
    return this.parseJSON(path, response);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(await this.credentials.restHeaders?.() ?? {})) {
      headers.set(name, value);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      if (init.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new NetworkError(path, { cause });
    }
  }

  private async parseJSON(path: string, response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new MalformedResponseError(path, response.status, { cause });
    }
  }

  private async throwResponseError(path: string, response: Response): Promise<never> {
    const data = await this.parseJSON(path, response);
    throw errorFromCoreEnvelope(validateCoreErrorEnvelope(data));
  }
}
