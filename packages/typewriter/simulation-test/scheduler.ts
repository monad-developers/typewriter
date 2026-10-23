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
  /**
   * Runs tasks and releases I/O, in a seeded order, until no task is ready and
   * no I/O is in flight.
   */
  runUntilIdle: () => Promise<void>;
};

export function makeSimScheduler(
  random: Random.Random,
  jumpRate: number,
  jump: () => void,
  ioRate: number,
): SimScheduler {
  const tasks: Task[] = [];
  const inFlight: Io[] = [];

  /** Runs one task of the lowest priority, picked at random. */
  const runOne = () => {
    if (jumpRate > 0 && random.nextDoubleUnsafe() < jumpRate) jump();
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

  /** Lets a promise outside `io` resume its fiber. If it needs more than one macrotask, the clock moves past it. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * Waits for one I/O, picked at random, then queues its result as a task. The
   * wait can be longer than for another I/O that finished first, so results
   * reach their fibers in the seeded order, not the order they finished.
   */
  const release = async () => {
    const index = Math.floor(random.nextDoubleUnsafe() * inFlight.length);
    const [next] = inFlight.splice(index, 1);
    const exit = await next!.exit;
    // Tasks that promises outside `io` queued during the wait go first, so
    // their order among the tasks does not depend on how long the wait was.
    await settle();
    schedule(() => next!.resume(exit));
  };

  const runUntilIdle = async () => {
    while (true) {
      if (tasks.length > 0) {
        // While tasks are ready, an I/O sometimes finishes before them.
        if (
          inFlight.length > 0 &&
          ioRate > 0 &&
          random.nextDoubleUnsafe() < ioRate
        ) {
          await release();
        } else runOne();
        continue;
      }
      if (inFlight.length > 0) {
        await release();
        continue;
      }
      await settle();
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
