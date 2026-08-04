import { PIXEL_COUNT, TEAM_COUNT } from "pixel-war-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "../lib/api";

type CanvasSnapshot = {
  epoch: number;
  epochStartedAt: number;
  teamPixels: number[];
  colors: string;
  shields: string;
};

type CanvasDelta = {
  epoch: number;
  epochStartedAt: number;
  teamPixels: number[];
  pixels: number[];
  shields: number[];
};

export type CanvasState = {
  colors: Uint8Array;
  shields: Uint8Array;
  epoch: number;
  epochStartedAt: number;
  teamPixels: number[];
  connected: boolean;
  /// Paints a pixel locally before the server confirms it, so the brush feels
  /// instant. The next server delta overwrites whatever this guessed.
  predict: (indexes: number[], color: number) => void;
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function useCanvasState(): CanvasState {
  // Deltas accumulate into these working copies; each change publishes a fresh
  // pair so consumers can depend on array identity instead of a revision
  // counter. A 16KB copy per frame is far cheaper than re-reading the canvas.
  const workingColors = useRef(new Uint8Array(PIXEL_COUNT));
  const workingShields = useRef(new Uint8Array(PIXEL_COUNT));

  const [published, setPublished] = useState<{
    colors: Uint8Array;
    shields: Uint8Array;
  }>(() => ({
    colors: new Uint8Array(PIXEL_COUNT),
    shields: new Uint8Array(PIXEL_COUNT),
  }));
  const [epoch, setEpoch] = useState(0);
  const [epochStartedAt, setEpochStartedAt] = useState(() => Date.now());
  const [teamPixels, setTeamPixels] = useState<number[]>(
    new Array(TEAM_COUNT).fill(0),
  );
  const [connected, setConnected] = useState(false);

  const publish = useCallback(() => {
    setPublished({
      colors: workingColors.current.slice(),
      shields: workingShields.current.slice(),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      const snapshot = await request<CanvasSnapshot>("/api/canvas");
      if (cancelled) return;
      workingColors.current.set(decodeBase64(snapshot.colors));
      workingShields.current.set(decodeBase64(snapshot.shields));
      setEpoch(snapshot.epoch);
      setEpochStartedAt(snapshot.epochStartedAt);
      setTeamPixels(snapshot.teamPixels);
      publish();
    }

    void loadSnapshot();

    const events = new EventSource("/api/events/canvas");
    events.addEventListener("open", () => setConnected(true));
    events.addEventListener("canvas", (event) => {
      const delta = JSON.parse((event as MessageEvent<string>).data) as
        | CanvasDelta
        | undefined;
      if (delta === undefined) return;
      for (let i = 0; i < delta.pixels.length; i += 2) {
        workingColors.current[delta.pixels[i]!] = delta.pixels[i + 1]!;
      }
      for (let i = 0; i < delta.shields.length; i += 2) {
        workingShields.current[delta.shields[i]!] = delta.shields[i + 1]!;
      }
      setEpoch(delta.epoch);
      setEpochStartedAt(delta.epochStartedAt);
      setTeamPixels(delta.teamPixels);
      publish();
    });
    events.onerror = () => setConnected(false);

    return () => {
      cancelled = true;
      events.close();
    };
  }, [publish]);

  const predict = useCallback(
    (indexes: number[], color: number) => {
      for (const index of indexes) {
        if (index < 0 || index >= PIXEL_COUNT) continue;
        // Shields absorb hits rather than changing color, matching the contract.
        if (workingShields.current[index] !== 0) continue;
        workingColors.current[index] = color;
      }
      publish();
    },
    [publish],
  );

  return {
    colors: published.colors,
    shields: published.shields,
    epoch,
    epochStartedAt,
    teamPixels,
    connected,
    predict,
  };
}
