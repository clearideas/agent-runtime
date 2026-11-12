/** Wake any HTTP-hosted showcase. Only the public endpoint crosses this API. */
export const showcaseUrl = (value) => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter the showcase's HTTP or HTTPS origin, without a path or credentials.",
    );
  return url.origin;
};

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });

/**
 * @param {string} endpoint
 * @param {{signal?: AbortSignal, onProgress?: (progress: {attempts: number, elapsedMs: number}) => void, timeoutMs?: number, requestTimeoutMs?: number, retryMs?: number, fetcher?: typeof fetch}} options
 */
export const waitForShowcase = async (
  endpoint,
  {
    signal,
    onProgress = () => {},
    timeoutMs = 180_000,
    requestTimeoutMs = 15_000,
    retryMs = 1500,
    fetcher = globalThis.fetch,
  } = {},
) => {
  const url = showcaseUrl(endpoint);
  const started = Date.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let attempts = 0;
  try {
    for (;;) {
      lifetime.throwIfAborted();
      onProgress({ attempts: ++attempts, elapsedMs: Date.now() - started });
      let response;
      try {
        response = await fetcher(`${url}/healthz`, {
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([
            lifetime,
            AbortSignal.timeout(requestTimeoutMs),
          ]),
        });
        if (response.ok) {
          const health = await response.json();
          if (health.status === "ready")
            return { url, health, elapsedMs: Date.now() - started, attempts };
        }
      } catch {
        lifetime.throwIfAborted();
        // DNS, startup disconnects, request timeouts, and CORS failures are
        // retried within the overall deadline. No run is ever retried here.
      }
      if (
        response &&
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status)
      )
        throw new Error(
          `The showcase returned HTTP ${response.status}. Check the endpoint configuration.`,
        );
      await pause(retryMs, lifetime);
    }
  } catch (error) {
    if (deadline.aborted && !signal?.aborted)
      throw new Error(
        "The showcase has not started yet. Check the deployment and allowed embedding origins, then try again.",
      );
    throw error;
  }
};
