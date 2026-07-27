import type {
  SandboxCommand,
  SandboxFileInfo,
  SandboxHandle,
  SandboxInputFile,
  SandboxProcessEvent,
  SandboxProvider,
  SandboxSpec,
} from "@clearideas/agent-runtime-sandbox";
import { assertSandboxPath } from "@clearideas/agent-runtime-sandbox";

export interface ModalSandboxGateway {
  create(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<{
    sandboxId: string;
    metadata?: Record<string, string | number | boolean>;
  }>;
  putFiles(
    sandboxId: string,
    files: SandboxInputFile[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  execute(
    sandboxId: string,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SandboxProcessEvent>;
  listFiles(
    sandboxId: string,
    directory: string,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxFileInfo[]>;
  readFile(
    sandboxId: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;
  terminate(sandboxId: string): Promise<void>;
}

export class ModalSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly #gateway: ModalSandboxGateway;

  constructor(gateway: ModalSandboxGateway, name = "modal") {
    this.#gateway = gateway;
    this.name = name;
  }

  async create(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxHandle> {
    const created = await this.#gateway.create(spec, options);
    if (!created.sandboxId.trim())
      throw new Error("Modal returned an empty sandbox ID.");
    return {
      id: created.sandboxId,
      provider: this.name,
      createdAt: new Date().toISOString(),
      providerData: {
        sandboxId: created.sandboxId,
        ...(created.metadata ?? {}),
      },
    };
  }

  putFiles(
    handle: SandboxHandle,
    files: SandboxInputFile[],
    options?: { signal?: AbortSignal },
  ) {
    for (const file of files) assertSandboxPath(file.path);
    return this.#gateway.putFiles(this.#id(handle), files, options);
  }

  execute(
    handle: SandboxHandle,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ) {
    if (command.cwd) assertSandboxPath(command.cwd);
    return this.#gateway.execute(this.#id(handle), command, options);
  }

  listFiles(
    handle: SandboxHandle,
    directory: string,
    options?: { signal?: AbortSignal },
  ) {
    return this.#gateway.listFiles(
      this.#id(handle),
      assertSandboxPath(directory),
      options,
    );
  }

  readFile(
    handle: SandboxHandle,
    path: string,
    options?: { signal?: AbortSignal },
  ) {
    return this.#gateway.readFile(
      this.#id(handle),
      assertSandboxPath(path),
      options,
    );
  }

  terminate(handle: SandboxHandle): Promise<void> {
    return this.#gateway.terminate(this.#id(handle));
  }

  #id(handle: SandboxHandle): string {
    if (
      handle.provider !== this.name ||
      typeof handle.providerData?.sandboxId !== "string"
    ) {
      throw new Error(
        "Sandbox handle does not belong to ModalSandboxProvider.",
      );
    }
    return handle.providerData.sandboxId;
  }
}
