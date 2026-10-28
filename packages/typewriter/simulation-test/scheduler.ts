import { Effect, type Exit, type Random, Scheduler } from "effect";

/**
 * A `Scheduler` for the fibers of one process. A crash drops every task of
 * the group, so its fibers never run again, and run no finalizers.
 */
export type SimGroup = Scheduler.Scheduler & { alive: boolean };

type Task = { run: () => void; priority: number; group: SimGroup };

type Io = {
  exit: Promise<Exit.Exit<unknown, unknown>>;
  resume: (exit: Exit.Exit<unknown, unknown>) => void;
  group: SimGroup;
};

/** A `Scheduler` that runs tasks only from the step loop, in a seeded order. */
export type SimScheduler = SimGroup & {
  /** Runs `effect` outside the simulation. Its result reaches the fiber in the order of the calls to `io`. */
  io: <a, e>(effect: Effect.Effect<a, e>) => Effect.Effect<a, e>;
  /** Queues `run` as a task of `group`. */
  schedule: (run: () => void, group: SimGroup) => void;
  /** A new group. Its tasks run in the same seeded order as every other. */
  group: () => SimGroup;
  /**
   * Drops the tasks of `group`, and each task it queues later. Its I/O in
   * flight still lands, since the process sent it, but no fiber sees the
   * result. Completes once that I/O has landed.
   */
  crash: (group: SimGroup) => Effect.Effect<void>;
  /** Whether `group` has a task ready or I/O in flight. */
  busy: (group: SimGroup) => boolean;
  /**
   * Runs tasks and releases I/O, in a seeded order, until no task is ready and
   * no I/O is in flight.
   */
  runUntilIdle: () => Promise<void>;
};

/** The group of the running fiber. */
export const currentGroup = Effect.withFiber((fiber) =>
  Effect.succeed(fiber.getRef(Scheduler.Scheduler) as SimGroup),
);

export function makeSimScheduler(
  random: Random.Random,
  jumpRate: number,
  jump: () => void,
  ioRate: number,
): SimScheduler {
  let tasks: Task[] = [];
  let inFlight: Io[] = [];

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

  const schedule = (run: () => void, group: SimGroup, priority = 0) => {
    if (group.alive) tasks.push({ run, priority, group });
  };

  const drain = () => {
    while (tasks.length > 0) runOne();
  };

  const makeGroup = (): SimGroup => {
    const group: SimGroup = {
      alive: true,
      executionMode: "async",
      shouldYield: (fiber) =>
        fiber.currentOpCount >= fiber.getRef(Scheduler.MaxOpsBeforeYield),
      makeDispatcher: () => ({
        scheduleTask: (run, priority) => schedule(run, group, priority),
        flush: drain,
      }),
    };
    return group;
  };

  const io = <a, e>(effect: Effect.Effect<a, e>) =>
    Effect.flatMap(currentGroup, (group) =>
      Effect.callback<a, e>((resume) => {
        // The task that a crash cut short can still reach here. Its process
        // is gone, so the I/O never starts.
        if (!group.alive) return;
        inFlight.push({
          exit: Effect.runPromiseExit(effect),
          resume: resume as Io["resume"],
          group,
        });
      }),
    );

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
    schedule(() => next!.resume(exit), next!.group);
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

  const crash = (group: SimGroup) =>
    Effect.suspend(() => {
      group.alive = false;
      tasks = tasks.filter((task) => task.group !== group);
      const landed = inFlight
        .filter((entry) => entry.group === group)
        .map((entry) => entry.exit);
      inFlight = inFlight.filter((entry) => entry.group !== group);
      return io(Effect.promise(() => Promise.all(landed))).pipe(Effect.asVoid);
    });

  return Object.assign(makeGroup(), {
    io,
    schedule: (run: () => void, group: SimGroup) => schedule(run, group),
    group: makeGroup,
    crash,
    busy: (group: SimGroup) =>
      tasks.some((task) => task.group === group) ||
      inFlight.some((entry) => entry.group === group),
    runUntilIdle,
  });
}
