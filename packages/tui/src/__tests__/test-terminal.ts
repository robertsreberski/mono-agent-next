import type { Terminal } from "@earendil-works/pi-tui";

export class TestTerminal implements Terminal {
  readonly writes: string[] = [];
  private input: ((data: string) => void) | undefined;
  private resizeListener: (() => void) | undefined;

  constructor(readonly columns = 100, readonly rows = 30) {}

  get kittyProtocolActive(): boolean { return false; }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resizeListener = onResize;
  }
  stop(): void {
    this.input = undefined;
    this.resizeListener = undefined;
  }
  feed(data: string): void { this.input?.(data); }
  resize(): void { this.resizeListener?.(); }
  output(): string { return this.writes.join(""); }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "")
    .replace(/\u001b\][^\u0007]*\u0007/gu, "")
    .replace(/\u001b_[^\u0007]*\u0007/gu, "");
}
