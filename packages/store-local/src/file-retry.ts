/**
 * Windows reports a file as busy while any process holds it open: antivirus
 * scanners, search indexers, and sync clients such as OneDrive open files as
 * soon as they change. Replacing or reading such a file then fails with
 * EPERM, EACCES, or EBUSY for a few milliseconds. These helpers retry those
 * transient errors with a short backoff, as graceful-fs and npm do. On other
 * platforms the same codes are real permission errors and are not retried.
 */
import { readFile, rename } from "node:fs/promises";

const TRANSIENT_WINDOWS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface FileRetryOptions {
  /** Defaults to process.platform; tests override it. */
  platform?: NodeJS.Platform;
  /** Total time to keep retrying before the last error is thrown. */
  maxWaitMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/** Run a file operation, retrying transient Windows sharing errors. */
export const withFileRetry = async <T>(
  operation: () => Promise<T>,
  options: FileRetryOptions = {},
): Promise<T> => {
  const platform = options.platform ?? process.platform;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  let waited = 0;
  let delayMs = 10;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        platform !== "win32" ||
        !code ||
        !TRANSIENT_WINDOWS_CODES.has(code) ||
        waited >= maxWaitMs
      )
        throw error;
      await sleep(delayMs);
      waited += delayMs;
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
};

/** Atomically replace `to` with `from`, tolerating brief Windows file locks. */
export const renameWithRetry = (
  from: string,
  to: string,
  options?: FileRetryOptions,
): Promise<void> => withFileRetry(() => rename(from, to), options);

/** Read a UTF-8 file, tolerating brief Windows file locks. */
export const readTextWithRetry = (
  file: string,
  options?: FileRetryOptions,
): Promise<string> => withFileRetry(() => readFile(file, "utf8"), options);
