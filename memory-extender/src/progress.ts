// Console progress reporting for long sidecar operations (story import and
// chat-history sentiment analysis). Output goes to the sidecar's console — the
// npm window — where the rest of the [ME:...] logs live.
//
// Toggle with MARINARA_EXTENDER_PROGRESS:
//   unset or "1"  → on (default; useful while testing)
//   "0"           → off
// A caller may also override per-operation by passing `enabled` explicitly.

export function progressEnabled(): boolean {
  return process.env.MARINARA_EXTENDER_PROGRESS !== "0";
}

function pct(current: number, total: number): number {
  return total > 0 ? Math.round(Math.min(1, current / total) * 100) : 0;
}

function bar(current: number, total: number, width = 16): string {
  const filled = total > 0 ? Math.round(Math.min(1, current / total) * width) : 0;
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

export class Progress {
  private lastLen = 0;
  private onLine = false; // true while a \r-updated bar line is "open"

  constructor(
    private readonly label: string,
    private readonly enabled: boolean = progressEnabled(),
  ) {}

  // A discrete stage transition, e.g. "parsing complete, analyzing sentiment...".
  stage(msg: string): void {
    if (!this.enabled) return;
    this.closeLine();
    console.log(`  ${msg}`);
  }

  // Update the in-place progress bar for the current item. `unit` names what is
  // being counted (e.g. "chunk", "window").
  tick(current: number, total: number, unit = "chunk"): void {
    if (!this.enabled) return;
    const line = `  importing "${this.label}" — ${unit} ${current}/${total} ${bar(current, total)} ${pct(current, total)}%`;
    if (process.stdout.isTTY) {
      const pad = Math.max(0, this.lastLen - line.length);
      process.stdout.write(`\r${line}${" ".repeat(pad)}`);
      this.lastLen = line.length;
      this.onLine = true;
    } else {
      // Redirected (e.g. to a file): avoid \r spam — log sparingly.
      if (current === total || current % 10 === 0) console.log(line.trimStart());
    }
  }

  // Per-item failure with the specific reason.
  error(current: number, reason: string): void {
    if (!this.enabled) return;
    this.closeLine();
    console.log(`  ERROR at chunk ${current}: ${reason}`);
  }

  // Final summary line.
  done(summary: string): void {
    if (!this.enabled) return;
    this.closeLine();
    console.log(`  ${summary}`);
  }

  // Finish any open \r bar line so the next console.log starts cleanly.
  private closeLine(): void {
    if (this.onLine && process.stdout.isTTY) {
      process.stdout.write("\n");
      this.onLine = false;
      this.lastLen = 0;
    }
  }
}
