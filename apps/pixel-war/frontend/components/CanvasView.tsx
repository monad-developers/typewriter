import { HEIGHT, PALETTE, WIDTH } from "pixel-war-sdk";
import { useEffect, useRef, useState } from "react";
import type { CanvasState } from "../hooks/useCanvasState";

type Point = { x: number; y: number };

/// Magnifications the viewer can pin. `fit` is the default and follows the
/// column width instead of a fixed level.
const ZOOM_LEVELS = [2, 4, 6, 8] as const;
type Zoom = (typeof ZOOM_LEVELS)[number] | "fit";

/// Fitting stops at the largest pinned level so a wide viewport cannot grow the
/// backing store without bound.
const MAX_FIT_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

const RGB_PALETTE = PALETTE.map(hexToRgb);

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/// CSS pixels are not canvas pixels: `max-w-full` shrinks the element on a
/// narrow viewport, so the rendered size has to come from the layout box rather
/// than from `zoom` alone. Returns backing-store pixels per CSS pixel.
function displayScale(display: HTMLCanvasElement, rect: DOMRect): Point {
  return {
    x: rect.width === 0 ? 1 : display.width / rect.width,
    y: rect.height === 0 ? 1 : display.height / rect.height,
  };
}

type Props = {
  canvas: CanvasState;
  onPick: (point: Point) => void;
  hover: Point | null;
  onHover: (point: Point | null) => void;
  /// Pixels the current tool would affect, highlighted under the cursor.
  footprint: number[];
};

export function CanvasView({
  canvas,
  onPick,
  hover,
  onHover,
  footprint,
}: Props) {
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<Zoom>("fit");
  const [fitZoom, setFitZoom] = useState<number>(4);
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  const panRef = useRef<{ from: Point; origin: Point } | null>(null);

  // Fitting to whole CSS pixels per canvas pixel is what keeps the art square
  // and crisp: at a fractional scale `image-rendering: pixelated` rounds each
  // pixel independently, so rows and columns come out uneven widths.
  const zoom = choice === "fit" ? fitZoom : choice;

  useEffect(() => {
    const column = columnRef.current;
    if (column === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setFitZoom(clamp(Math.floor(width / WIDTH), 1, MAX_FIT_ZOOM));
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  // The offscreen buffer holds the canvas at 1:1 and is blitted at whatever zoom
  // the viewer picked, so a repaint costs one putImageData plus one drawImage.
  useEffect(() => {
    let buffer = bufferRef.current;
    if (buffer === null) {
      buffer = document.createElement("canvas");
      buffer.width = WIDTH;
      buffer.height = HEIGHT;
      bufferRef.current = buffer;
    }
    const bufferCtx = buffer.getContext("2d");
    const display = displayRef.current;
    const displayCtx = display?.getContext("2d");
    if (!bufferCtx || !display || !displayCtx) return;

    const image = bufferCtx.createImageData(WIDTH, HEIGHT);
    for (let index = 0; index < canvas.colors.length; index++) {
      const [r, g, b] = RGB_PALETTE[canvas.colors[index]!] ?? RGB_PALETTE[0]!;
      const offset = index * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
    bufferCtx.putImageData(image, 0, 0);

    displayCtx.imageSmoothingEnabled = false;
    displayCtx.clearRect(0, 0, display.width, display.height);
    displayCtx.drawImage(
      buffer,
      0,
      0,
      WIDTH,
      HEIGHT,
      -origin.x * zoom,
      -origin.y * zoom,
      WIDTH * zoom,
      HEIGHT * zoom,
    );

    // Shielded pixels get a light outline so defended ground is readable.
    displayCtx.strokeStyle = "rgba(255,255,255,0.55)";
    displayCtx.lineWidth = Math.max(1, zoom / 8);
    for (let index = 0; index < canvas.shields.length; index++) {
      if (canvas.shields[index] === 0) continue;
      const x = (index % WIDTH) - origin.x;
      const y = Math.floor(index / WIDTH) - origin.y;
      displayCtx.strokeRect(x * zoom + 0.5, y * zoom + 0.5, zoom - 1, zoom - 1);
    }

    if (hover !== null) {
      displayCtx.strokeStyle = "rgba(255,255,255,0.9)";
      displayCtx.lineWidth = 1;
      for (const index of footprint) {
        const x = (index % WIDTH) - origin.x;
        const y = Math.floor(index / WIDTH) - origin.y;
        displayCtx.strokeRect(
          x * zoom - 0.5,
          y * zoom - 0.5,
          zoom + 1,
          zoom + 1,
        );
      }
    }
  }, [canvas.colors, canvas.shields, zoom, origin, hover, footprint]);

  function pointFrom(event: React.MouseEvent<HTMLCanvasElement>): Point | null {
    const display = displayRef.current;
    if (display === null) return null;
    const rect = display.getBoundingClientRect();
    const scale = displayScale(display, rect);
    const x =
      Math.floor(((event.clientX - rect.left) * scale.x) / zoom) + origin.x;
    const y =
      Math.floor(((event.clientY - rect.top) * scale.y) / zoom) + origin.y;
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return null;
    return { x, y };
  }

  return (
    <div ref={columnRef} className="flex flex-col gap-2">
      <canvas
        ref={displayRef}
        width={WIDTH * zoom}
        height={HEIGHT * zoom}
        // `self-start` keeps flex from stretching the canvas past its backing
        // store: at its natural size one canvas pixel is exactly `zoom` CSS
        // pixels, so the zoom buttons scale by whole pixels and stay crisp.
        className="pixelated self-start border border-edge bg-canvas cursor-crosshair max-w-full"
        onMouseDown={(event) => {
          // Middle button or shift-drag pans; plain clicks act on a pixel.
          if (event.button === 1 || event.shiftKey) {
            panRef.current = {
              from: { x: event.clientX, y: event.clientY },
              origin,
            };
            return;
          }
          const point = pointFrom(event);
          if (point !== null) onPick(point);
        }}
        onMouseMove={(event) => {
          const pan = panRef.current;
          if (pan !== null) {
            const display = displayRef.current;
            if (display === null) return;
            const scale = displayScale(
              display,
              display.getBoundingClientRect(),
            );
            // Same CSS-to-canvas conversion as pointFrom, so the canvas tracks
            // the cursor one-for-one while dragging.
            const dragged = {
              x: Math.round(((event.clientX - pan.from.x) * scale.x) / zoom),
              y: Math.round(((event.clientY - pan.from.y) * scale.y) / zoom),
            };
            setOrigin({
              x: clamp(pan.origin.x - dragged.x, 0, WIDTH - 1),
              y: clamp(pan.origin.y - dragged.y, 0, HEIGHT - 1),
            });
            return;
          }
          onHover(pointFrom(event));
        }}
        onMouseUp={() => {
          panRef.current = null;
        }}
        onMouseLeave={() => {
          panRef.current = null;
          onHover(null);
        }}
      />
      <div className="flex items-center gap-3 text-xs text-dim">
        <span>zoom</span>
        {(["fit", ...ZOOM_LEVELS] as const).map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => {
              setChoice(level);
              setOrigin({ x: 0, y: 0 });
            }}
            className={`px-2 py-0.5 border ${
              choice === level
                ? "border-ink text-ink"
                : "border-edge hover:border-dim"
            }`}
          >
            {level === "fit" ? "fit" : `${level}x`}
          </button>
        ))}
        <span className="ml-2">
          {choice === "fit" && `${zoom}x · `}shift-drag to pan
        </span>
        <span className="ml-auto tabular-nums">
          {hover === null ? "—" : `${hover.x}, ${hover.y}`}
        </span>
      </div>
    </div>
  );
}
