/**
 * Start a run and deliver each NDJSON message as it arrives.
 * Aborting the signal closes the request, which cancels the run on the server.
 */
export const streamRun = async (url, body, onMessage, signal) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      // plain-text error
    }
    throw new Error(message || `Request failed with HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line));
    }
  }
  if (buffer.trim()) onMessage(JSON.parse(buffer));
};
