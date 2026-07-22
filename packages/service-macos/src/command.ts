import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly signal?: AbortSignal;
}

export interface CommandRunner {
  run(command: string, arguments_: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export const processCommandRunner: CommandRunner = Object.freeze({
  async run(
    command: string,
    arguments_: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...arguments_], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const append = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > 1_048_576) {
          child.kill("SIGKILL");
          reject(new Error("launchctl output exceeded 1 MiB."));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  },
});
