import type { Terminal } from "@earendil-works/pi-tui";

/**
 * In-memory Terminal for tests (pi-tui 0.79 ships no VirtualTerminal). Fixed
 * viewport, captured writes, and a `feed()` hook that replays bytes through
 * the TUI input pipeline exactly like a real keyboard.
 */
export class TestTerminal implements Terminal {
  readonly writes: string[] = [];
  private onInput: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;

  constructor(
    private readonly width = 80,
    private readonly height = 24,
  ) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop(): void {
    this.onInput = undefined;
    this.onResize = undefined;
  }

  feed(data: string): void {
    this.onInput?.(data);
  }

  resize(): void {
    this.onResize?.();
  }

  output(): string {
    return this.writes.join("");
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes.push(data);
  }

  get columns(): number {
    return this.width;
  }

  get rows(): number {
    return this.height;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

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
  // Control Sequence Introducer + OSC/APC sequences.
  return text
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "")
    .replace(/\u001b\][^\u0007]*\u0007/gu, "")
    .replace(/\u001b_[^\u0007]*\u0007/gu, "");
}
