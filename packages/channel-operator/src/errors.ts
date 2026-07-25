// SPDX-License-Identifier: MIT
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperatorHttpError";
  }
}

export class StreamClosedError extends Error {
  constructor() {
    super("Operator stream closed.");
    this.name = "StreamClosedError";
  }
}

export class StreamLimitError extends Error {
  constructor() {
    super("Operator stream exceeded its byte limit.");
    this.name = "StreamLimitError";
  }
}
