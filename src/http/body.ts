/** A byte budget exceeded before the body was fully buffered. */
export class BodyLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`request body is larger than ${limit} bytes`);
    this.limit = limit;
  }
}

/** Bound stream consumption even when Content-Length is absent or incorrect. */
export async function readBoundedBody(input: Request | Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!input.body) return new Uint8Array(0);
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyLimitError(limit);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
