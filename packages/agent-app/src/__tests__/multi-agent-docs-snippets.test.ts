import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  forEachChild,
  formatDiagnostics,
  getPreEmitDiagnostics,
  isArrowFunction,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isFunctionLike,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isVariableStatement,
  parseJsonConfigFileContent,
  readConfigFile,
  ScriptKind,
  ScriptTarget,
  sys,
  SyntaxKind,
  type CallExpression,
  type CompilerOptions,
  type Diagnostic,
  type Expression,
  type NodeArray,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type ReturnStatement,
  type Statement,
  type VariableDeclaration,
} from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this test until the pnpm workspace root. */
function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

const root = repoRoot();

const cases = [
  {
    label: "composer playbook Multi-agent orchestration",
    docPath: "packages/agent-app/skills/mono-agent-composer/references/playbooks.md",
    heading: "8. Multi-agent orchestration (`AskCollaborator`) — code",
    prelude: `
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createCollaboratorToolRuntimeExtension } from "@mono-agent/agent-orchestrator";

declare const config: MonoAgentConfig;
declare const researcher: AgentResponder;
declare const writer: AgentResponder;
`,
  },
  {
    label: "playbook Configuration",
    docPath: "docs/playbooks/multi-agent-orchestration.md",
    heading: "Configuration",
    prelude: `
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createCollaboratorToolRuntimeExtension } from "@mono-agent/agent-orchestrator";

declare const config: MonoAgentConfig;
declare const researcherResponder: AgentResponder;
declare const writerResponder: AgentResponder;
`,
  },
  {
    label: "programmatic Wiring into the orchestrator",
    docPath: "docs/programmatic/multi-agent.md",
    heading: "Wiring into the orchestrator",
    prelude: `
import type { MonoAgentConfig } from "@mono-agent/config";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";

declare const researcherUrl: string;
declare const workerUrl: string;
declare const timeoutMs: number;
declare const orchestratorCoreConfig: MonoAgentConfig;
declare const orchestratorRuntime: MonoRuntimeLike;
`,
  },
] as const;

describe("multi-agent documentation snippets", () => {
  for (const testCase of cases) {
    it(`type-checks the complete ${testCase.label} snippet against exported APIs`, () => {
      const absoluteDocPath = join(root, testCase.docPath);
      const markdown = readFileSync(absoluteDocPath, "utf8");
      const snippet = typescriptSnippet(markdownSection(markdown, testCase.heading), testCase.docPath);
      expectRequestScopedCollaboratorLifecycle(snippet, testCase.docPath);
      const source = `
import type { AgentResponder as ExpectedAgentResponder } from "@mono-agent/agent-contracts";
${testCase.prelude}
${snippet}
const expectedOrchestrator: ExpectedAgentResponder = orchestrator;
void expectedOrchestrator;
`;
      const diagnostics = typecheck(source, join(dirname(absoluteDocPath), ".multi-agent-snippet.typecheck.ts"));

      expect(format(diagnostics), `${testCase.docPath} has a stale TypeScript snippet`).toBe("");
    });
  }

  it("does not accept lifecycle fragments that exist only in comments", () => {
    const misleadingSnippet = `
const orchestrator = await createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (input) => {
    // const extension = await createCollaboratorToolRuntimeExtension({
    // conversationId: input.request.conversationId
    // originalUserMessage: input.request.userMessage
    // abortSignal: input.request.abortSignal
    // return { runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup };
    return { runtimeOptions: {} };
  },
});
`;

    expect(() => expectRequestScopedCollaboratorLifecycle(misleadingSnippet, "synthetic.md")).toThrow(
      "synthetic.md must directly declare an awaited collaborator extension",
    );
  });

  it("extracts one exact heading and normalizes CRLF TypeScript fences", () => {
    const markdown = [
      "Prose mentions ## Target but is not a heading.",
      "## Target",
      "```ts",
      "const answer = 42;",
      "```",
      "## Next",
      "Ignored.",
    ].join("\r\n");

    expect(typescriptSnippet(markdownSection(markdown, "Target"), "synthetic.md")).toBe("const answer = 42;");
  });

  it("rejects an alternate return that omits request cleanup", () => {
    const misleadingSnippet = `
const orchestrator = await createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (input) => {
    const extension = await createCollaboratorToolRuntimeExtension({
      collaborators,
      conversationId: input.request.conversationId,
      originalUserMessage: input.request.userMessage,
      abortSignal: input.request.abortSignal,
    });
    if (input.request.userMessage === "skip") return { runtimeOptions: {} };
    return { runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup };
  },
});
`;

    expect(() => expectRequestScopedCollaboratorLifecycle(misleadingSnippet, "synthetic.md")).toThrow(
      "synthetic.md must have exactly one direct lifecycle return",
    );
  });
});

function expectRequestScopedCollaboratorLifecycle(snippet: string, docPath: string): void {
  const sourceFile = createSourceFile(
    `${docPath}.ts`,
    snippet,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  const orchestrator = variableDeclaration(sourceFile.statements, "orchestrator");
  assertStructure(
    orchestrator !== undefined,
    `${docPath} must directly declare the orchestrator responder`,
  );
  const responderCall = awaitedNamedCall(
    orchestrator.initializer,
    "createConfiguredAgentResponder",
    `${docPath} must await createConfiguredAgentResponder`,
  );
  const responderOptions = firstObjectArgument(
    responderCall,
    `${docPath} must pass object options to createConfiguredAgentResponder`,
  );
  const runtimeOptionsProperty = propertyAssignment(responderOptions, "runtimeOptionsForRequest");
  assertStructure(
    runtimeOptionsProperty !== undefined,
    `${docPath} must define runtimeOptionsForRequest`,
  );
  const callback = runtimeOptionsProperty.initializer;
  assertStructure(
    isArrowFunction(callback),
    `${docPath} must define runtimeOptionsForRequest as an arrow callback`,
  );
  assertStructure(
    callback.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true,
    `${docPath} runtimeOptionsForRequest callback must be async`,
  );
  const callbackBody = callback.body;
  assertStructure(
    isBlock(callbackBody),
    `${docPath} runtimeOptionsForRequest must use a block body`,
  );
  const inputParameter = callback.parameters[0];
  assertStructure(
    callback.parameters.length === 1
      && inputParameter !== undefined
      && isIdentifier(inputParameter.name)
      && inputParameter.name.text === "input",
    `${docPath} runtimeOptionsForRequest must accept the request input`,
  );

  const extension = variableDeclaration(callbackBody.statements, "extension");
  assertStructure(
    extension !== undefined,
    `${docPath} must directly declare an awaited collaborator extension`,
  );
  const extensionCall = awaitedNamedCall(
    extension.initializer,
    "createCollaboratorToolRuntimeExtension",
    `${docPath} must await createCollaboratorToolRuntimeExtension`,
  );
  const extensionOptions = firstObjectArgument(
    extensionCall,
    `${docPath} must pass object options to createCollaboratorToolRuntimeExtension`,
  );
  expectPropertyPath(extensionOptions, "conversationId", ["input", "request", "conversationId"], docPath);
  expectPropertyPath(extensionOptions, "originalUserMessage", ["input", "request", "userMessage"], docPath);
  expectPropertyPath(extensionOptions, "abortSignal", ["input", "request", "abortSignal"], docPath);

  const returnStatements: ReturnStatement[] = [];
  forEachChild(callbackBody, function collectReturns(node): void {
    if (isReturnStatement(node)) returnStatements.push(node);
    if (isFunctionLike(node)) return;
    forEachChild(node, collectReturns);
  });
  const returnStatement = returnStatements[0];
  assertStructure(
    returnStatements.length === 1
      && returnStatement !== undefined
      && callbackBody.statements.includes(returnStatement),
    `${docPath} must have exactly one direct lifecycle return`,
  );
  assertStructure(
    returnStatement.expression !== undefined,
    `${docPath} lifecycle return must include request-scoped runtime options and cleanup`,
  );
  const returnedOptions = returnStatement.expression;
  assertStructure(
    isObjectLiteralExpression(returnedOptions),
    `${docPath} must directly return object runtime options and cleanup`,
  );
  expectPropertyPath(returnedOptions, "runtimeOptions", ["extension", "runtimeOptions"], docPath);
  expectPropertyPath(returnedOptions, "cleanup", ["extension", "cleanup"], docPath);
}

function markdownSection(markdown: string, heading: string): string {
  const normalized = normalizeLineEndings(markdown);
  const marker = `## ${heading}`;
  const matches = [...normalized.matchAll(new RegExp(`^${escapeRegExp(marker)}$`, "gmu"))];
  const match = matches[0];
  if (matches.length !== 1 || match?.index === undefined) {
    throw new Error(`expected exactly one "${marker}" section; found ${matches.length}`);
  }
  const rest = normalized.slice(match.index + marker.length);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
}

function typescriptSnippet(section: string, docPath: string): string {
  const matches = [...normalizeLineEndings(section).matchAll(/```ts\n([\s\S]*?)\n```/gu)];
  if (matches.length !== 1) {
    throw new Error(
      `${docPath} must have exactly one TypeScript block in the checked section; found ${matches.length}`,
    );
  }
  return matches[0]?.[1] ?? "";
}

function variableDeclaration(
  statements: NodeArray<Statement>,
  name: string,
): VariableDeclaration | undefined {
  for (const statement of statements) {
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

function awaitedNamedCall(
  expression: Expression | undefined,
  functionName: string,
  message: string,
): CallExpression {
  assertStructure(expression !== undefined && isAwaitExpression(expression), message);
  const call = expression.expression;
  assertStructure(
    isCallExpression(call) && isIdentifier(call.expression) && call.expression.text === functionName,
    message,
  );
  return call;
}

function firstObjectArgument(call: CallExpression, message: string): ObjectLiteralExpression {
  const argument = call.arguments[0];
  assertStructure(argument !== undefined && isObjectLiteralExpression(argument), message);
  return argument;
}

function propertyAssignment(
  object: ObjectLiteralExpression,
  name: string,
): PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is PropertyAssignment =>
      isPropertyAssignment(property)
      && ((isIdentifier(property.name) || isStringLiteral(property.name)) && property.name.text === name),
  );
}

function expectPropertyPath(
  object: ObjectLiteralExpression,
  propertyName: string,
  expectedPath: readonly string[],
  docPath: string,
): void {
  const property = propertyAssignment(object, propertyName);
  const actualPath = property === undefined ? undefined : expressionPath(property.initializer);
  assertStructure(
    actualPath?.join(".") === expectedPath.join("."),
    `${docPath} must set ${propertyName} to ${expectedPath.join(".")}`,
  );
}

function expressionPath(expression: Expression): readonly string[] | undefined {
  if (isIdentifier(expression)) return [expression.text];
  if (!isPropertyAccessExpression(expression)) return undefined;
  const parent = expressionPath(expression.expression);
  return parent === undefined ? undefined : [...parent, expression.name.text];
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertStructure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function compilerOptions(): CompilerOptions {
  const configPath = join(root, "tsconfig.base.json");
  const loaded = readConfigFile(configPath, sys.readFile);
  if (loaded.error !== undefined) {
    throw new Error(format([loaded.error]));
  }
  const parsed = parseJsonConfigFileContent(
    loaded.config,
    sys,
    root,
    { noEmit: true, types: ["node"] },
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(format(parsed.errors));
  }
  return parsed.options;
}

function typecheck(source: string, virtualPath: string) {
  const options = compilerOptions();
  const host = createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) => fileName === virtualPath || sys.fileExists(fileName);
  host.readFile = (fileName) => fileName === virtualPath ? source : sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === virtualPath
      ? createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

  return getPreEmitDiagnostics(createProgram([virtualPath], options, host));
}

function format(diagnostics: readonly Diagnostic[]): string {
  return formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => relative(root, fileName),
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });
}
