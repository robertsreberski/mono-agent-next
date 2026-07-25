import {
  OPERATOR_LIMITS,
  parseAskAnswerRequest,
  type OperatorAsk,
  type OperatorAskAnswerRequest,
} from "@mono-agent/operator";

export function parseTuiAskAnswer(value: string, ask: OperatorAsk): OperatorAskAnswerRequest {
  if (value.length === 0) {
    throw new Error('Use /answer {"question":"value","other-question":["value-1","value-2"]}.');
  }
  if (Buffer.byteLength(value) > OPERATOR_LIMITS.askAnswerRequestBytes) {
    throw new Error("AskUser answer exceeds the shared operator request bound.");
  }
  const questions = new Map(ask.questions.map((question) => [question.id, question]));
  const answerEntries = value.startsWith("{")
    ? structuredAnswerEntries(value)
    : legacyAnswerEntries(value);
  const answers = new Map<string, readonly string[]>();
  for (const [questionId, values] of answerEntries) {
    if (answers.has(questionId)) {
      throw new Error(`Question ${JSON.stringify(questionId)} is answered more than once.`);
    }
    const question = questions.get(questionId);
    if (question === undefined) {
      throw new Error(`Question ${JSON.stringify(questionId)} is not pending.`);
    }
    if (values.length === 0) {
      throw new Error(`Question ${JSON.stringify(questionId)} requires an answer.`);
    }
    if (!question.multiple && values.length !== 1) {
      throw new Error(`Question ${JSON.stringify(questionId)} accepts exactly one answer.`);
    }
    if (!question.allowFreeText) {
      const choices = new Set(question.choices?.map((choice) => choice.value) ?? []);
      const unknown = values.find((answer) => !choices.has(answer));
      if (unknown !== undefined) {
        throw new Error(`Answer ${JSON.stringify(unknown)} is not a choice for ${JSON.stringify(questionId)}.`);
      }
    }
    answers.set(questionId, values);
  }
  const missing = ask.questions.filter((question) => !answers.has(question.id)).map((question) => question.id);
  if (missing.length > 0) {
    throw new Error(`Answer every pending question; missing ${missing.map((id) => JSON.stringify(id)).join(", ")}.`);
  }
  const parsed = parseAskAnswerRequest({
    interactionId: ask.interactionId,
    answers: Object.fromEntries(answers),
  });
  if (Buffer.byteLength(JSON.stringify(parsed)) > OPERATOR_LIMITS.askAnswerRequestBytes) {
    throw new Error("AskUser answer exceeds the shared operator request bound.");
  }
  return parsed;
}

function structuredAnswerEntries(value: string): Array<[string, readonly string[]]> {
  let input: unknown;
  try {
    input = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Structured /answer input must be valid JSON.");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Structured /answer input must be a JSON object.");
  }
  return Object.entries(input).map(([questionId, answer]) => {
    if (typeof answer === "string") return [questionId, [answer]];
    if (Array.isArray(answer) && answer.every((item) => typeof item === "string")) {
      return [questionId, answer];
    }
    throw new Error(`Answer for ${JSON.stringify(questionId)} must be a string or string array.`);
  });
}

function legacyAnswerEntries(value: string): Array<[string, readonly string[]]> {
  return value.split(";").map((rawAssignment) => {
    const assignment = rawAssignment.trim();
    const separator = assignment.indexOf("=");
    if (separator <= 0 || separator === assignment.length - 1) {
      throw new Error('Use /answer {"question":"value","other-question":["value-1","value-2"]}.');
    }
    const questionId = assignment.slice(0, separator).trim();
    const values = assignment.slice(separator + 1).split(",")
      .map((answer) => answer.trim())
      .filter(Boolean);
    return [questionId, values];
  });
}
