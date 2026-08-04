import {
  bombFootprint,
  CANVAS_WORDS,
  PIXEL_COUNT,
  PIXELS_PER_WORD,
  TEAM_COUNT,
  toPixelIndex,
  unpackWord,
  wordOfPixel,
} from "pixel-war-sdk";

/// Reads the contract's state through the runtime, never a private copy of the
/// game rules. Mutation events only say which pixels a mutation touched; the
/// colors themselves always come back from `typewriter.state`, so the mirror
/// cannot drift from what the contract decided.
export type StateReader = {
  epoch: PromiseLike<bigint | number>;
  canvas: Record<number, PromiseLike<bigint>>;
  shields: Record<string, PromiseLike<bigint | number>>;
  teamPixels: Record<number, PromiseLike<bigint | number>>;
};

export type PixelDelta = { index: number; color: number };
export type ShieldDelta = { index: number; charges: number };

export type CanvasSnapshot = {
  epoch: number;
  colors: Uint8Array;
  shields: Uint8Array;
  teamPixels: number[];
};

export type CanvasFlush = {
  epoch: number;
  pixels: PixelDelta[];
  shields: ShieldDelta[];
  teamPixels: number[];
};

export type MutationTouch = {
  name: string;
  params: Record<string, unknown>;
};

function toNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export class Canvas {
  readonly colors = new Uint8Array(PIXEL_COUNT);
  readonly shields = new Uint8Array(PIXEL_COUNT);
  teamPixels: number[] = new Array(TEAM_COUNT).fill(0);
  epoch = 0;

  private readonly dirtyWords = new Set<number>();
  private readonly dirtyShields = new Set<number>();
  private epochDirty = false;

  constructor(private readonly state: StateReader) {}

  /// Full read of canvas words, team counters, and any shield charges the runtime
  /// has seen. Used at startup and after a restart rehydrates local state.
  async load(): Promise<void> {
    const words = await Promise.all(
      Array.from(
        { length: CANVAS_WORDS },
        (_, word) => this.state.canvas[word],
      ),
    );
    words.forEach((word, index) => {
      unpackWord(word ?? 0n, this.colors, index);
    });

    this.epoch = toNumber(await this.state.epoch);
    this.teamPixels = await Promise.all(
      Array.from({ length: TEAM_COUNT }, async (_, team) =>
        toNumber((await this.state.teamPixels[team]) ?? 0),
      ),
    );

    this.shields.fill(0);
    for (const key of this.knownShieldKeys()) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= PIXEL_COUNT) {
        continue;
      }
      const charges = await this.state.shields[key];
      if (charges !== undefined) this.shields[index] = toNumber(charges);
    }
  }

  /// Mapping keys are only enumerable when the runtime has recorded the slot
  /// preimage, so treat this as best effort: a missed key self-heals the first
  /// time that pixel is touched again.
  private knownShieldKeys(): string[] {
    try {
      return Object.keys(this.state.shields);
    } catch {
      return [];
    }
  }

  /// Queues the pixels a mutation could have changed. Bomb footprints are derived
  /// with the same clipping rule the contract uses.
  touch(mutation: MutationTouch): void {
    const x = Number(mutation.params.x);
    const y = Number(mutation.params.y);

    switch (mutation.name) {
      case "Paint": {
        this.markPixel(toPixelIndex(x, y));
        return;
      }
      case "Shield": {
        const index = toPixelIndex(x, y);
        this.markPixel(index);
        this.dirtyShields.add(index);
        return;
      }
      case "Bomb": {
        for (const index of bombFootprint(x, y)) {
          this.markPixel(index);
          this.dirtyShields.add(index);
        }
        return;
      }
      case "AdvanceEpoch": {
        this.epochDirty = true;
        return;
      }
      default:
        return;
    }
  }

  private markPixel(index: number): void {
    if (index < 0 || index >= PIXEL_COUNT) return;
    this.dirtyWords.add(wordOfPixel(index));
    // A paint that a shield absorbs spends the charge instead of the color, so
    // any touched pixel needs its shield re-read too.
    this.dirtyShields.add(index);
  }

  /// Re-reads dirty words and shields, applies them to the mirror, and returns
  /// only what actually changed.
  async flush(): Promise<CanvasFlush | null> {
    const epochDirty = this.epochDirty;
    if (
      this.dirtyWords.size === 0 &&
      this.dirtyShields.size === 0 &&
      !epochDirty
    ) {
      return null;
    }

    const words = [...this.dirtyWords];
    const shieldIndexes = [...this.dirtyShields];
    this.dirtyWords.clear();
    this.dirtyShields.clear();
    this.epochDirty = false;

    const pixels: PixelDelta[] = [];
    const shields: ShieldDelta[] = [];
    const scratch = new Uint8Array(PIXELS_PER_WORD);

    const wordValues = await Promise.all(
      words.map((word) => this.state.canvas[word]),
    );
    words.forEach((word, i) => {
      unpackWord(wordValues[i] ?? 0n, scratch, 0);
      const base = word * PIXELS_PER_WORD;
      for (let slot = 0; slot < PIXELS_PER_WORD; slot++) {
        const index = base + slot;
        const color = scratch[slot]!;
        if (this.colors[index] !== color) {
          this.colors[index] = color;
          pixels.push({ index, color });
        }
      }
    });

    const shieldValues = await Promise.all(
      shieldIndexes.map((index) => this.state.shields[String(index)]),
    );
    shieldIndexes.forEach((index, i) => {
      const charges = toNumber(shieldValues[i] ?? 0);
      if (this.shields[index] !== charges) {
        this.shields[index] = charges;
        shields.push({ index, charges });
      }
    });

    const [epoch, teamPixels] = await Promise.all([
      this.state.epoch,
      Promise.all(
        Array.from({ length: TEAM_COUNT }, async (_, team) =>
          toNumber((await this.state.teamPixels[team]) ?? 0),
        ),
      ),
    ]);
    this.epoch = toNumber(epoch);
    this.teamPixels = teamPixels;

    if (pixels.length === 0 && shields.length === 0 && !epochDirty) return null;
    return {
      epoch: this.epoch,
      pixels,
      shields,
      teamPixels: this.teamPixels,
    };
  }

  snapshot(): CanvasSnapshot {
    return {
      epoch: this.epoch,
      colors: this.colors,
      shields: this.shields,
      teamPixels: this.teamPixels,
    };
  }
}
