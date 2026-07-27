import path from "node:path";

import {
  assertSandboxResourceLimits,
  assertSandboxPath,
  type SandboxInputFile,
  type SandboxProvider,
  type SandboxSpec,
} from "@clearideas/agent-runtime-sandbox";

export interface ArtifactFileInput {
  filename: string;
  content: Uint8Array | string;
  mediaType?: string;
}

export interface ArtifactRuntimeFile {
  path: string;
  content: Uint8Array | string;
  mode?: number;
}

export interface ArtifactRuntimeProfile {
  id: string;
  image: string;
  language: string;
  extension: string;
  command: string;
  args(sourcePath: string): string[];
}

export interface ArtifactGenerationLimits {
  timeoutMs: number;
  memoryMb?: number;
  cpuCount?: number;
  processLimit?: number;
  maximumStdoutBytes?: number;
  maximumStderrBytes?: number;
  maximumOutputBytes?: number;
  maximumOutputFiles?: number;
}

export interface ArtifactGenerationRequest {
  artifactType: string;
  filename: string;
  code: string;
  runtime: ArtifactRuntimeProfile;
  inputs?: ArtifactFileInput[];
  runtimeFiles?: ArtifactRuntimeFile[];
  environment?: Record<string, string>;
  limits: ArtifactGenerationLimits;
  metadata?: Record<string, string | number | boolean>;
}

export interface GeneratedArtifact {
  filename: string;
  content: Uint8Array;
  bytes: number;
  mediaType: string;
}

export interface ArtifactGenerationResult {
  outputs: GeneratedArtifact[];
  stdout: string;
  stderr: string;
  exitCode: number;
  provider: string;
}

export interface ArtifactValidationResult {
  valid: boolean;
  message?: string;
  mediaType?: string;
}

export interface ArtifactValidator {
  validate(
    content: Uint8Array,
    context: { artifactType: string; filename: string },
  ): ArtifactValidationResult | Promise<ArtifactValidationResult>;
}

export interface ArtifactGeneratorOptions {
  provider: SandboxProvider;
  validators?: Record<string, ArtifactValidator>;
  allowedEnvironment?: string[];
}

const safeFilename = (value: string): string => {
  const normalized = path.posix.basename(value.trim());
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized !== value.trim()
  ) {
    throw new Error(`Artifact filename must not contain a path: ${value}`);
  }
  return normalized;
};

const appendBounded = (
  current: string,
  chunk: string,
  maximum: number,
): string => {
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined) > maximum) {
    throw new Error(`Artifact process output exceeded ${maximum} bytes.`);
  }
  return combined;
};

const defaultMediaType = (artifactType: string): string =>
  ({
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf",
  })[artifactType] ?? "application/octet-stream";

export class OpenXmlArtifactValidator implements ArtifactValidator {
  validate(
    content: Uint8Array,
    context: { artifactType: string; filename: string },
  ) {
    const expectedExtension = `.${context.artifactType.toLowerCase()}`;
    if (!context.filename.toLowerCase().endsWith(expectedExtension)) {
      return {
        valid: false,
        message: `Expected a ${expectedExtension} output.`,
      };
    }
    if (content.byteLength < 4 || content[0] !== 0x50 || content[1] !== 0x4b) {
      return {
        valid: false,
        message: "OpenXML output is not a ZIP container.",
      };
    }
    return { valid: true, mediaType: defaultMediaType(context.artifactType) };
  }
}

export class ArtifactGenerator {
  readonly #provider: SandboxProvider;
  readonly #validators: Readonly<Record<string, ArtifactValidator>>;
  readonly #allowedEnvironment: ReadonlySet<string>;

  constructor(options: ArtifactGeneratorOptions) {
    this.#provider = options.provider;
    this.#validators = options.validators ?? {
      xlsx: new OpenXmlArtifactValidator(),
      docx: new OpenXmlArtifactValidator(),
      pptx: new OpenXmlArtifactValidator(),
    };
    this.#allowedEnvironment = new Set(options.allowedEnvironment ?? []);
  }

  async generate(
    request: ArtifactGenerationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ArtifactGenerationResult> {
    const expectedFilename = safeFilename(request.filename);
    const maximumOutputBytes =
      request.limits.maximumOutputBytes ?? 25 * 1024 * 1024;
    const maximumOutputFiles = request.limits.maximumOutputFiles ?? 20;
    const spec: SandboxSpec = {
      image: request.runtime.image,
      workingDirectory: "/workspace",
      network: "none",
      limits: {
        timeoutMs: request.limits.timeoutMs,
        ...(request.limits.memoryMb != null
          ? { memoryMb: request.limits.memoryMb }
          : {}),
        ...(request.limits.cpuCount != null
          ? { cpuCount: request.limits.cpuCount }
          : {}),
        ...(request.limits.processLimit != null
          ? { processLimit: request.limits.processLimit }
          : {}),
        maximumOutputBytes,
        maximumOutputFiles,
      },
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
    assertSandboxResourceLimits(spec.limits);
    const handle = await this.#provider.create(spec, options);
    try {
      const sourcePath = `/workspace/main.${request.runtime.extension}`;
      const files: SandboxInputFile[] = [
        { path: sourcePath, content: request.code, mode: 0o600 },
        ...(request.inputs ?? []).map((input) => ({
          path: `/workspace/input/${safeFilename(input.filename)}`,
          content: input.content,
          mode: 0o600,
        })),
        ...(request.runtimeFiles ?? []).map((file) => ({
          path: assertSandboxPath(file.path),
          content: file.content,
          ...(file.mode != null ? { mode: file.mode } : {}),
        })),
      ];
      await this.#provider.putFiles(handle, files, options);
      const environment = Object.fromEntries(
        Object.entries(request.environment ?? {}).filter(([name]) =>
          this.#allowedEnvironment.has(name),
        ),
      );
      environment.ARTIFACT_INPUT_DIRECTORY = "/workspace/input";
      environment.ARTIFACT_OUTPUT_DIRECTORY = "/workspace/output";
      environment.ARTIFACT_EXPECTED_FILENAME = expectedFilename;
      environment.ARTIFACT_TYPE = request.artifactType;

      let stdout = "";
      let stderr = "";
      let exitCode: number | undefined;
      for await (const event of this.#provider.execute(
        handle,
        {
          command: request.runtime.command,
          args: request.runtime.args(sourcePath),
          cwd: "/workspace",
          environment,
          timeoutMs: request.limits.timeoutMs,
        },
        options,
      )) {
        if (event.type === "stdout") {
          stdout = appendBounded(
            stdout,
            event.data,
            request.limits.maximumStdoutBytes ?? 1_048_576,
          );
        } else if (event.type === "stderr") {
          stderr = appendBounded(
            stderr,
            event.data,
            request.limits.maximumStderrBytes ?? 1_048_576,
          );
        } else {
          exitCode = event.exitCode;
        }
      }
      if (exitCode == null)
        throw new Error("Artifact process ended without an exit event.");
      if (exitCode !== 0)
        throw new Error(
          `Artifact process exited with ${exitCode}: ${stderr.trim()}`,
        );

      const outputFiles = await this.#provider.listFiles(
        handle,
        "/workspace/output",
        options,
      );
      if (outputFiles.length === 0)
        throw new Error("Artifact process produced no output files.");
      if (outputFiles.length > maximumOutputFiles) {
        throw new Error(
          `Artifact process produced ${outputFiles.length} files, exceeding ${maximumOutputFiles}.`,
        );
      }
      const validator = this.#validators[request.artifactType];
      const outputs: GeneratedArtifact[] = [];
      let aggregateBytes = 0;
      for (const output of outputFiles) {
        const outputPath = assertSandboxPath(output.path);
        if (!outputPath.startsWith("/workspace/output/")) {
          throw new Error(
            `Artifact output escaped /workspace/output: ${outputPath}`,
          );
        }
        const filename = safeFilename(path.posix.basename(outputPath));
        const content = await this.#provider.readFile(
          handle,
          outputPath,
          options,
        );
        aggregateBytes += content.byteLength;
        if (aggregateBytes > maximumOutputBytes) {
          throw new Error(
            `Artifact output exceeded ${maximumOutputBytes} bytes.`,
          );
        }
        const validation = validator
          ? await validator.validate(content, {
              artifactType: request.artifactType,
              filename,
            })
          : { valid: true };
        if (!validation.valid) {
          throw new Error(
            validation.message ?? `Artifact validation failed for ${filename}.`,
          );
        }
        outputs.push({
          filename: outputFiles.length === 1 ? expectedFilename : filename,
          content,
          bytes: content.byteLength,
          mediaType:
            validation.mediaType ?? defaultMediaType(request.artifactType),
        });
      }
      return {
        outputs,
        stdout,
        stderr,
        exitCode,
        provider: this.#provider.name,
      };
    } finally {
      await this.#provider.terminate(handle);
    }
  }
}
