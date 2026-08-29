/**
 * The one outbound `fetch` wrapper, plus the concurrency bound that keeps a
 * fan-out tool from opening an unbounded number of connections at once.
 *
 * Every outbound call in this server goes through `fetchWithTimeout`: MCP has no
 * timeout of its own, so an unresponsive host does not fail a tool call, it
 * suspends it for as long as the client is willing to wait.
 */

/** Raised when a request did not complete within its deadline. */
export class FetchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'FetchTimeoutError';
  }
}

/** Raised when a response body exceeds the ceiling the caller asked for. */
export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response exceeds the ${maxBytes} byte ceiling`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * `fetch` with a hard deadline. An abort raised by our own timer surfaces as
 * {@link FetchTimeoutError}; any other failure propagates untouched, so a DNS or
 * TLS error is never reported as a timeout.
 */
export async function fetchWithTimeout(
  url: URL | string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new FetchTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body, refusing anything past `maxBytes`.
 *
 * `content-length` is checked first because it is free, and the buffered length
 * afterwards because the header is a hint: it may be absent (chunked responses)
 * or untruthful.
 */
export async function readBoundedArrayBuffer(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new ResponseTooLargeError(maxBytes);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new ResponseTooLargeError(maxBytes);
  return buffer;
}

/** As {@link readBoundedArrayBuffer}, decoded as UTF-8 text. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedArrayBuffer(response, maxBytes));
}

/**
 * Cap how many of `tasks` run at once, preserving result order.
 *
 * A report that fans out over every company in an account issues four API calls
 * per company; unbounded, an account with fifty companies opens two hundred
 * connections simultaneously and is rate-limited for its trouble.
 */
export async function pLimit<T>(limit: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
