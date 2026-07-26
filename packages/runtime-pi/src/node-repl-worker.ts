// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { start } from "node:repl";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;
const NODE_REPL_CONTROL_PREFIX = "\u001eMONO_AGENT_NODE_REPL_V1:";
const protocolWrite = process.stdout.write.bind(process.stdout);
const input = new PassThrough();
const output = new PassThrough();
const server = start({
  input,
  output,
  prompt: "",
  terminal: false,
  useGlobal: false,
});

interface WorkerRequest {
  readonly type: "evaluate";
  readonly id: string;
  readonly code: string;
}

interface WorkerResult {
  readonly type: "result";
  readonly id: string;
  readonly ok: boolean;
  readonly reset?: boolean;
  readonly text: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface ActiveEvaluation {
  readonly id: string;
  output: string;
  stdout: string;
  stderr: string;
  bytes: number;
}

let active: ActiveEvaluation | undefined;

function send(message: WorkerResult): void {
  try {
    protocolWrite(`${NODE_REPL_CONTROL_PREFIX}${JSON.stringify(message)}\n`);
  } catch {
    process.exit(1);
  }
}

function errorText(error: unknown): string {
  const value = error !== null && typeof error === "object" && "err" in error
    ? Reflect.get(error, "err")
    : error;
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value ?? "Node REPL evaluation failed.");
}

function finish(ok: boolean, text: string, reset = false): void {
  const request = active;
  if (request === undefined) return;
  active = undefined;
  const value = String(text);
  const responseBytes = Buffer.byteLength(value, "utf8")
    + Buffer.byteLength(request.stdout, "utf8")
    + Buffer.byteLength(request.stderr, "utf8");
  if (responseBytes > MAX_OUTPUT_BYTES) {
    send({
      type: "result",
      id: request.id,
      ok: false,
      reset: true,
      text: `Node REPL output exceeded ${String(MAX_OUTPUT_BYTES)} bytes.`,
    });
    setImmediate(() => process.exit(1));
    return;
  }
  send({
    type: "result",
    id: request.id,
    ok,
    reset,
    text: value,
    stdout: request.stdout,
    stderr: request.stderr,
  });
}

type ProcessWrite = (
  chunk: Uint8Array | string,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
) => boolean;

function captureProcessWrite(
  field: "stdout" | "stderr",
  originalWrite: ProcessWrite,
): ProcessWrite {
  return (chunk, encodingOrCallback, callback) => {
    if (active === undefined) return originalWrite(chunk, encodingOrCallback, callback);
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const resolvedCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    active.bytes += buffer.byteLength;
    if (active.bytes > MAX_OUTPUT_BYTES) {
      finish(false, `Node REPL output exceeded ${String(MAX_OUTPUT_BYTES)} bytes.`, true);
      setImmediate(() => process.exit(1));
      return false;
    }
    active[field] += buffer.toString("utf8");
    if (resolvedCallback !== undefined) queueMicrotask(() => resolvedCallback());
    return true;
  };
}

const stdout = process.stdout as unknown as { write: ProcessWrite };
const stderr = process.stderr as unknown as { write: ProcessWrite };
stdout.write = captureProcessWrite("stdout", stdout.write.bind(stdout));
stderr.write = captureProcessWrite("stderr", stderr.write.bind(stderr));

output.on("data", (chunk: Buffer) => {
  if (active === undefined) return;
  active.bytes += chunk.byteLength;
  if (active.bytes > MAX_OUTPUT_BYTES) {
    finish(false, `Node REPL output exceeded ${String(MAX_OUTPUT_BYTES)} bytes.`, true);
    setImmediate(() => process.exit(1));
    return;
  }
  active.output += chunk.toString("utf8");
});

// The default evaluator prints runtime exceptions and then calls this public
// completion hook instead of passing every exception to the eval callback.
server.displayPrompt = () => {
  if (active === undefined) return;
  finish(false, active.output.trimEnd() || "Node REPL evaluation failed.");
};

function evaluate(message: WorkerRequest): void {
  if (active !== undefined) {
    send({
      type: "result",
      id: message.id,
      ok: false,
      text: "Node REPL is already evaluating code.",
    });
    return;
  }
  if (message.code.trim().length === 0) {
    send({
      type: "result",
      id: message.id,
      ok: false,
      text: "Node REPL code must not be empty.",
    });
    return;
  }
  active = { id: message.id, output: "", stdout: "", stderr: "", bytes: 0 };
  try {
    server.eval(message.code, server.context, "<mono-agent-node-repl>", (error, value) => {
      if (active === undefined || active.id !== message.id) return;
      if (error !== null) {
        if (!server.underscoreErrAssigned) Reflect.set(server, "lastError", error);
        finish(
          false,
          [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"),
        );
        return;
      }
      if (!server.underscoreAssigned) Reflect.set(server, "last", value);
      try {
        finish(true, `${active.output}${server.writer(value)}`.trimEnd());
      } catch (error) {
        finish(
          false,
          [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"),
        );
      }
    });
  } catch (error) {
    finish(
      false,
      [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"),
    );
  }
}

function workerRequest(line: string): WorkerRequest {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_LINE_BYTES) {
    throw new Error("Node REPL request exceeds its bounded line limit.");
  }
  const value = JSON.parse(line) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Node REPL request must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3
    || keys[0] !== "code"
    || keys[1] !== "id"
    || keys[2] !== "type"
    || Reflect.get(value, "type") !== "evaluate"
    || typeof Reflect.get(value, "id") !== "string"
    || typeof Reflect.get(value, "code") !== "string"
  ) {
    throw new Error("Node REPL request is invalid.");
  }
  return value as WorkerRequest;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    evaluate(workerRequest(line));
  } catch {
    process.exit(1);
  }
});
lines.once("close", () => {
  server.close();
  process.exit(0);
});
process.stdin.once("error", () => process.exit(1));
