export function percentile(values: readonly number[], p: number): number {
  const index = Math.min(
    values.length - 1,
    Math.floor((values.length - 1) * p),
  );
  return values[index]!;
}

export function formatMs(durationMs: number): string {
  return `${durationMs.toFixed(2)}ms`;
}

// Runtime debug logs that carry a `duration` annotation, keyed by message.
const PHASES = {
  "executed mutation": "evm execute (per mutation)",
  "batched mutations": "accept batch (per batch)",
  "persisted accepted mutations": "persist batch (per batch)",
} as const;

type Phase = keyof typeof PHASES;

// Runs `run` with console output captured instead of printed, so the
// benchmark measures the runtime and not terminal I/O. Log formatting and
// serialization still run, as they do in production.
export async function withCapturedLogs<T>(
  run: () => Promise<T>,
): Promise<{ result: T; phases: string }> {
  const original = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const lines: unknown[] = [];
  const capture = (line: unknown) => {
    lines.push(line);
  };

  console.debug = capture;
  console.error = capture;
  console.info = capture;
  console.log = capture;
  console.warn = capture;

  let result: T;
  try {
    result = await run();
  } finally {
    console.debug = original.debug;
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }

  const durations = new Map<Phase, number[]>();
  for (const line of lines) {
    if (typeof line !== "string" || !line.startsWith("{")) continue;
    const entry = JSON.parse(line) as {
      message?: string;
      annotations?: { duration?: number };
    };
    const message = entry.message as Phase | undefined;
    const duration = entry.annotations?.duration;
    if (message === undefined || !(message in PHASES)) continue;
    if (duration === undefined) continue;
    const values = durations.get(message) ?? [];
    values.push(duration);
    durations.set(message, values);
  }

  const phases = (Object.keys(PHASES) as Phase[])
    .map((phase) => {
      const values = durations.get(phase) ?? [];
      if (values.length === 0) return `${PHASES[phase]}: n/a`;
      const total = values.reduce((sum, value) => sum + value, 0);
      return `${PHASES[phase]}: avg ${formatMs(total / values.length)} x ${values.length.toLocaleString()} = ${formatMs(total)}`;
    })
    .join("\n");

  return { result, phases };
}
