/** Optional HTTP hosting support. No hosting-provider SDK belongs here. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export const parseOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`Expected an HTTP origin, received ${value}`);
  return url.origin;
};

/** Signed, opaque session cookies bind all demo files to one visitor. */
export const createSessionResolver = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  const keyPath = path.join(directory, "session-signing.key");
  await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const key = await readFile(keyPath);
  if (key.length !== 32)
    throw new Error("The showcase session signing key must contain 32 bytes.");
  const sign = (id: string) =>
    createHmac("sha256", key).update(id).digest("hex");
  return (
    request: IncomingMessage,
    response: ServerResponse,
    secure: boolean,
  ) => {
    const cookie = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("showcase_session="))
      ?.slice("showcase_session=".length);
    const [id = "", signature = ""] = (cookie ?? "").split(".");
    if (
      /^[a-f0-9]{32}$/u.test(id) &&
      /^[a-f0-9]{64}$/u.test(signature) &&
      timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(sign(id), "hex"),
      )
    )
      return id;
    const created = randomBytes(16).toString("hex");
    response.setHeader("set-cookie", [
      `showcase_session=${created}.${sign(created)}; Path=/; HttpOnly; Max-Age=604800; ${
        secure ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"
      }`,
    ]);
    return created;
  };
};
