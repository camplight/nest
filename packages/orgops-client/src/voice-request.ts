const MAX_JOIN_BYTES = 16 * 1024;

// Undici cannot retry a streaming request body after a 401 challenge (its body
// source is null), and reports a network error instead of forwarding the 401.
// A join is a small JSON envelope: retain its source without buffering uploads.
export async function voiceJoinBody(body: BodyInit): Promise<BodyInit | Response> {
  if (!(body instanceof ReadableStream)) return body;
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JOIN_BYTES) {
        await reader.cancel();
        return Response.json({error: 'Voice join request is too large'}, {status: 413});
      }
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return bytes;
}
