/** The public Harness TokenDelta body is distinct from the legacy Serve SSE frame. */
export interface FactoryLiveText {
  readonly loopId: string;
  readonly turnId: string;
  readonly text: string;
}

export const MAX_FACTORY_LIVE_TEXT_CHUNK_BYTES = 16_384;
export const MAX_FACTORY_LIVE_TEXT_BODY_BYTES = 32_768;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export function decodeFactoryLiveText(body: unknown, publicSessionId: string): FactoryLiveText | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    return null;
  }
  if (encoder.encode(encoded).byteLength > MAX_FACTORY_LIVE_TEXT_BODY_BYTES) return null;
  const value = body as Record<string, unknown>;
  if (value["v"] !== 1 || value["type"] !== "TokenDelta"
    || typeof value["session_id"] !== "string" || value["session_id"] !== publicSessionId
    || typeof value["loop_id"] !== "string" || !uuid.test(value["loop_id"])
    || typeof value["turn_id"] !== "string" || !uuid.test(value["turn_id"])) return null;
  const chunk = value["chunk"];
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) return null;
  const fields = chunk as Record<string, unknown>;
  if (fields["chunk_type"] !== "text" || typeof fields["text"] !== "string"
    || fields["text"] === "" || encoder.encode(fields["text"]).byteLength > MAX_FACTORY_LIVE_TEXT_CHUNK_BYTES) return null;
  return { loopId: value["loop_id"], turnId: value["turn_id"], text: fields["text"] };
}
