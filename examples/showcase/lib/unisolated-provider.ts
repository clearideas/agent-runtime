/**
 * DEMO FALLBACK ONLY — provides no isolation whatsoever.
 *
 * Wraps the sandbox package's test-only HostProcessTestProvider, which runs
 * commands as ordinary host processes in a temporary directory and rewrites
 * `/workspace` paths (in argv, environment values, and the workspace index
 * that code steps read) to that directory. Never use this outside a local
 * demo.
 */
import type {
  SandboxCommand,
  SandboxHandle,
  SandboxProcessEvent,
} from "@clearideas/agent-runtime";
import { HostProcessTestProvider } from "@clearideas/agent-runtime-sandbox/testing";

const isHelper = (command: SandboxCommand) =>
  command.args?.some((argument) => argument.endsWith("/bin/agent-fs")) ?? false;

export class UnisolatedDemoProvider extends HostProcessTestProvider {
  readonly #python: string | undefined;

  /** @param python absolute interpreter path to run instead of `python3` */
  constructor(python?: string) {
    super();
    this.#python = python;
  }

  /**
   * The base provider runs commands with only PATH set, which breaks
   * `python3` shims that need HOME. Run the real interpreter instead. If its
   * path contains "/workspace" (which the base provider rewrites), keep
   * `python3` and pass HOME through.
   */
  #resolve(command: SandboxCommand): SandboxCommand {
    if (command.command !== "python3" || !this.#python) return command;
    if (!/\/workspace(?=\/|$)/u.test(this.#python))
      return { ...command, command: this.#python };
    return {
      ...command,
      environment: { ...command.environment, HOME: process.env.HOME ?? "" },
    };
  }

  /**
   * Agent Runtime reports a failed helper operation (for example a workspace
   * snapshot) without the helper's error output. Print it to the server
   * console so demo failures on unusual machines can be diagnosed.
   */
  override async *execute(
    handle: SandboxHandle,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SandboxProcessEvent> {
    const stderr: string[] = [];
    for await (const event of super.execute(
      handle,
      this.#resolve(command),
      options,
    )) {
      if (event.type === "stderr") stderr.push(event.data);
      // Exit codes 2-5 are the helper's documented refusals (usage, path,
      // limit, read-only); anything else means it could not run properly.
      if (
        event.type === "exit" &&
        ![0, 2, 3, 4, 5].includes(event.exitCode) &&
        isHelper(command)
      ) {
        const operation =
          command.args?.[
            command.args.findIndex((argument) =>
              argument.endsWith("/bin/agent-fs"),
            ) + 1
          ];
        console.error(
          `[showcase] sandbox helper "${operation}" exited with ${event.exitCode} (${process.platform}, ${command.command}).\n${stderr.join("").trim() || "(no error output)"}`,
        );
      }
      yield event;
    }
  }
}
