import { Effect, type Exit, type Random, Scheduler } from "effect";

type Task = { run: () => void; priority: number };

type Io = {
  exit: Promise<Exit.Exit<unknown, unknown>>;
  resume: (exit: Exit.Exit<unknown, unknown>) => void;
};

/** A `Scheduler` that runs tasks only from the step loop, in a seeded order. */
export type SimScheduler = Scheduler.Scheduler & {
  /** Runs `effect` outside the simulation. Its result reaches the fiber in the order of the calls to `io`. */
  io: <a, e>(effect: Effect.Effect<a, e>) => Effect.Effect<a, e>;
  /** Queues `run` as a task. */
  schedule: (run: () => void) => void;
  /** Runs tasks and releases I/O until no task is ready and no I/O is in flight. */
  runUntilIdle: () => Promise<void>;
};

export function makeSimScheduler(random: Random.Random): SimScheduler {
  const tasks: Task[] = [];
  const inFlight: Io[] = [];

  /** Runs one task of the lowest priority, picked at random. */
  const runOne = () => {
    let priority = Number.POSITIVE_INFINITY;
    for (const task of tasks) priority = Math.min(priority, task.priority);
    const ready: number[] = [];
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i]!.priority === priority) ready.push(i);
    }
    const index = ready[Math.floor(random.nextDoubleUnsafe() * ready.length)]!;
    const [task] = tasks.splice(index, 1);
    task!.run();
  };

  const schedule = (run: () => void) => {
    tasks.push({ run, priority: 0 });
  };

  const drain = () => {
    while (tasks.length > 0) runOne();
  };

  const io = <a, e>(effect: Effect.Effect<a, e>) =>
    Effect.callback<a, e>((resume) => {
      inFlight.push({
        exit: Effect.runPromiseExit(effect),
        resume: resume as Io["resume"],
      });
    });

  const runUntilIdle = async () => {
    while (true) {
      drain();
      const next = inFlight.shift();
      if (next !== undefined) {
        const exit = await next.exit;
        schedule(() => next.resume(exit));
        continue;
      }
      // A promise outside `io` gets one macrotask to resume its fiber. If it is slower, the clock moves past it.
      await new Promise((resolve) => setImmediate(resolve));
      if (tasks.length === 0 && inFlight.length === 0) return;
    }
  };

  return {
    executionMode: "async",
    shouldYield: (fiber) =>
      fiber.currentOpCount >= fiber.getRef(Scheduler.MaxOpsBeforeYield),
    makeDispatcher: () => ({
      scheduleTask: (run, priority) => {
        tasks.push({ run, priority });
      },
      flush: drain,
    }),
    io,
    schedule,
    runUntilIdle,
  };
}
