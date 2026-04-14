"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { candlesOptions } from "~/lib/queries";
import type { BucketSize, Candle } from "~/lib/types";
import { API_URL } from "~/lib/constants";
import { cn } from "~/lib/utils";
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  UTCTimestamp,
  type ISeriesApi,
  type SeriesType,
  type IChartApi,
  type LogicalRange,
} from "lightweight-charts";

const BUCKET_OPTIONS: BucketSize[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

const DEFAULT_VISIBLE_BARS = 100;

type WindowPreset = "1H" | "6H" | "1D" | "1W" | "1M";

const WINDOW_PRESETS: {
  id: WindowPreset;
  bucket: BucketSize;
  seconds: number;
}[] = [
  { id: "1H", bucket: "1m", seconds: 3600 },
  { id: "6H", bucket: "5m", seconds: 21600 },
  { id: "1D", bucket: "15m", seconds: 86400 },
  { id: "1W", bucket: "1h", seconds: 604800 },
  { id: "1M", bucket: "4h", seconds: 2592000 },
];

function mapCandles(candles: Candle[]) {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

function mapVolume(candles: Candle[]) {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? "rgba(0,192,118,0.4)" : "rgba(255,83,83,0.4)",
  }));
}

const SHARED_LAYOUT = {
  background: { type: ColorType.Solid as const, color: "transparent" },
  textColor: "#808080",
};

const SHARED_GRID = {
  vertLines: { color: "rgba(255,255,255,0.04)" },
  horzLines: { color: "rgba(255,255,255,0.04)" },
};

export function PriceChart({
  instrument,
  bucket,
  onBucketChange,
}: {
  instrument: string;
  bucket: BucketSize;
  onBucketChange: (b: BucketSize) => void;
}) {
  const queryClient = useQueryClient();
  const { data: candles } = useSuspenseQuery(
    candlesOptions(instrument, bucket)
  );

  const priceContainerRef = useRef<HTMLDivElement>(null);
  const volumeContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const volumeChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);

  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const syncingRef = useRef(false);

  const [activeWindow, setActiveWindow] = useState<WindowPreset | null>(null);

  // Create both charts on mount and sync their time scales
  useEffect(() => {
    const priceContainer = priceContainerRef.current;
    const volumeContainer = volumeContainerRef.current;
    if (!priceContainer || !volumeContainer) return;

    const priceChart = createChart(priceContainer, {
      width: priceContainer.clientWidth,
      height: priceContainer.clientHeight,
      layout: { ...SHARED_LAYOUT, attributionLogo: false },
      grid: SHARED_GRID,
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
        minimumWidth: 80,
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
        visible: false,
      },
    });

    const volumeChart = createChart(volumeContainer, {
      width: volumeContainer.clientWidth,
      height: volumeContainer.clientHeight,
      layout: SHARED_LAYOUT,
      grid: SHARED_GRID,
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
        minimumWidth: 80,
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: "#00c076",
      downColor: "#ff5353",
      borderUpColor: "#00c076",
      borderDownColor: "#ff5353",
      wickUpColor: "#00c076",
      wickDownColor: "#ff5353",
    });

    const volumeSeries = volumeChart.addSeries(HistogramSeries, {
      color: "rgba(0,192,118,0.4)",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });

    priceChartRef.current = priceChart;
    volumeChartRef.current = volumeChart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Reset so the data-sync effect does a full setData on this new chart
    prevCandlesRef.current = null;

    // Sync time scales bidirectionally
    const syncRange = (target: IChartApi, range: LogicalRange | null) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      target.timeScale().setVisibleLogicalRange(range);
      syncingRef.current = false;
    };

    priceChart
      .timeScale()
      .subscribeVisibleLogicalRangeChange((range) =>
        syncRange(volumeChart, range)
      );
    volumeChart
      .timeScale()
      .subscribeVisibleLogicalRangeChange((range) =>
        syncRange(priceChart, range)
      );

    const resizeObserver = new ResizeObserver(() => {
      if (priceContainerRef.current && priceChartRef.current) {
        const { clientWidth, clientHeight } = priceContainerRef.current;
        priceChartRef.current.applyOptions({
          width: clientWidth,
          height: clientHeight,
        });
      }
      if (volumeContainerRef.current && volumeChartRef.current) {
        const { clientWidth, clientHeight } = volumeContainerRef.current;
        volumeChartRef.current.applyOptions({
          width: clientWidth,
          height: clientHeight,
        });
      }
    });
    resizeObserver.observe(priceContainer);
    resizeObserver.observe(volumeContainer);

    return () => {
      resizeObserver.disconnect();
      priceChart.remove();
      volumeChart.remove();
      priceChartRef.current = null;
      volumeChartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Scroll-back pagination — prepends older candles into the query cache
  useEffect(() => {
    const chart = priceChartRef.current;
    if (!chart) return;

    const handler = (range: LogicalRange | null) => {
      if (
        !range ||
        range.from > 10 ||
        loadingRef.current ||
        !hasMoreRef.current
      )
        return;

      const cached = queryClient.getQueryData<Candle[]>([
        "candles",
        instrument,
        bucket,
      ]);
      const oldest = cached?.[0];
      if (!oldest) return;

      loadingRef.current = true;
      fetch(
        `${API_URL}/api/candles?instrumentId=${encodeURIComponent(instrument)}&bucket=${bucket}&before=${oldest.time}&count=200`
      )
        .then((res) => res.json())
        .then((data: { candles: Candle[]; hasMore: boolean }) => {
          if (data.candles.length > 0) {
            queryClient.setQueryData<Candle[]>(
              ["candles", instrument, bucket],
              (old) => [...data.candles, ...(old ?? [])]
            );
          }
          hasMoreRef.current = data.hasMore;
          loadingRef.current = false;
        })
        .catch(() => {
          loadingRef.current = false;
        });
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [instrument, bucket, queryClient]);

  // Sync chart series data from the query cache (single source of truth).
  const prevCandlesRef = useRef<Candle[] | null>(null);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries || candles.length === 0) return;

    const prev = prevCandlesRef.current;
    prevCandlesRef.current = candles;

    // Live tick update: array only differs at the tail end
    if (prev && prev.length > 0 && candles.length >= prev.length) {
      const prevLast = prev[prev.length - 1];
      const curLast = candles[candles.length - 1];

      const sameDataSet = prev[0] === candles[0];
      const isLiveUpdate =
        sameDataSet &&
        (candles.length === prev.length
          ? prevLast.time === curLast.time
          : candles.length === prev.length + 1 &&
            prev[prev.length - 1] === candles[candles.length - 2]);

      if (isLiveUpdate) {
        candleSeries.update({
          time: curLast.time as UTCTimestamp,
          open: curLast.open,
          high: curLast.high,
          low: curLast.low,
          close: curLast.close,
        });
        volumeSeries.update({
          time: curLast.time as UTCTimestamp,
          value: curLast.volume,
          color:
            curLast.close >= curLast.open
              ? "rgba(0,192,118,0.4)"
              : "rgba(255,83,83,0.4)",
        });
        return;
      }
    }

    // Full reload: instrument/bucket change, pagination, or initial mount
    candleSeries.setData(mapCandles(candles));
    volumeSeries.setData(mapVolume(candles));

    const total = candles.length;
    const padding = Math.round(DEFAULT_VISIBLE_BARS * 0.1);
    priceChartRef.current?.timeScale().setVisibleLogicalRange({
      from: total - DEFAULT_VISIBLE_BARS,
      to: total + padding,
    });
  }, [candles]);

  const handleBucketClick = useCallback(
    (b: BucketSize) => {
      setActiveWindow(null);
      hasMoreRef.current = true;
      onBucketChange(b);
    },
    [onBucketChange]
  );

  const handleWindowClick = useCallback(
    (preset: (typeof WINDOW_PRESETS)[number]) => {
      setActiveWindow(preset.id);
      hasMoreRef.current = true;
      onBucketChange(preset.bucket);

      requestAnimationFrame(() => {
        const chart = priceChartRef.current;
        if (!chart) return;
        const now = Math.floor(Date.now() / 1000);
        const padding = Math.round(preset.seconds * 0.1);
        chart.timeScale().setVisibleRange({
          from: (now - preset.seconds) as UTCTimestamp,
          to: (now + padding) as UTCTimestamp,
        });
      });
    },
    [onBucketChange]
  );

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        {BUCKET_OPTIONS.map((b) => (
          <button
            key={b}
            onClick={() => handleBucketClick(b)}
            className={cn(
              "px-2 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer",
              bucket === b && activeWindow === null
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {b}
          </button>
        ))}
        <div className="w-px h-4 bg-border mx-1" />
        {WINDOW_PRESETS.map((preset) => (
          <button
            key={preset.id}
            onClick={() => handleWindowClick(preset)}
            className={cn(
              "px-2 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer",
              activeWindow === preset.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {preset.id}
          </button>
        ))}
      </div>
      <div ref={priceContainerRef} className="w-full" style={{ flex: 4 }} />
      <div className="relative border-t border-border" style={{ flex: 1 }}>
        <span className="absolute top-2 left-3 z-10 text-xs text-muted-foreground/70 pointer-events-none">
          Volume
        </span>
        <div ref={volumeContainerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
