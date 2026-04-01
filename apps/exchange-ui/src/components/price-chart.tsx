"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { candlesOptions } from "~/lib/queries";
import type { BucketSize, Candle } from "~/lib/types";
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
  const { data: candles } = useSuspenseQuery(
    candlesOptions(instrument, bucket)
  );

  // liveCandle is written to cache by useMarketStream — read it reactively
  const { data: liveCandle } = useQuery<Candle | null>({
    queryKey: ["liveCandle", instrument, bucket],
    queryFn: () => null,
    enabled: false,
  });

  const priceContainerRef = useRef<HTMLDivElement>(null);
  const volumeContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const volumeChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);

  const prevInstrumentRef = useRef(instrument);
  const prevBucketRef = useRef(bucket);
  const prevCandleLenRef = useRef(0);
  const allCandlesRef = useRef<Candle[]>([]);
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

    // Sync time scales bidirectionally
    const syncRange = (
      target: IChartApi,
      range: LogicalRange | null
    ) => {
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

  // Scroll-back pagination (driven by price chart)
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

      const oldest = allCandlesRef.current[0];
      if (!oldest) return;

      loadingRef.current = true;
      fetch(
        `/api/candles?instrument=${encodeURIComponent(instrument)}&bucket=${bucket}&before=${oldest.time}&count=200`
      )
        .then((res) => res.json())
        .then((data: { candles: Candle[]; hasMore: boolean }) => {
          if (data.candles.length > 0) {
            allCandlesRef.current = [
              ...data.candles,
              ...allCandlesRef.current,
            ];
            candleSeriesRef.current?.setData(
              mapCandles(allCandlesRef.current)
            );
            volumeSeriesRef.current?.setData(
              mapVolume(allCandlesRef.current)
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
  }, [instrument, bucket]);

  // Helper to set visible range on both charts
  const setVisibleBars = useCallback(
    (total: number, barCount: number = DEFAULT_VISIBLE_BARS) => {
      const padding = Math.round(barCount * 0.1);
      const range = { from: total - barCount, to: total + padding };
      priceChartRef.current?.timeScale().setVisibleLogicalRange(range);
    },
    []
  );

  // Update data when candles, instrument, or bucket changes
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries || candles.length === 0) return;

    const instrumentChanged = prevInstrumentRef.current !== instrument;
    const bucketChanged = prevBucketRef.current !== bucket;

    if (instrumentChanged || bucketChanged) {
      allCandlesRef.current = [...candles];
      hasMoreRef.current = true;
      candleSeries.setData(mapCandles(candles));
      volumeSeries.setData(mapVolume(candles));
      setVisibleBars(allCandlesRef.current.length);
      prevInstrumentRef.current = instrument;
      prevBucketRef.current = bucket;
      prevCandleLenRef.current = candles.length;
    } else if (candles.length !== prevCandleLenRef.current) {
      const oldestServer = candles[0]?.time ?? 0;
      const olderCandles = allCandlesRef.current.filter(
        (c) => c.time < oldestServer
      );
      allCandlesRef.current = [...olderCandles, ...candles];
      candleSeries.setData(mapCandles(allCandlesRef.current));
      volumeSeries.setData(mapVolume(allCandlesRef.current));
      setVisibleBars(allCandlesRef.current.length);
      prevCandleLenRef.current = candles.length;
    }
  }, [candles, instrument, bucket, setVisibleBars]);

  // Real-time updates from server's liveCandle
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries || !liveCandle) return;

    const all = allCandlesRef.current;
    const last = all[all.length - 1];

    if (last && last.time === liveCandle.time) {
      last.open = liveCandle.open;
      last.high = liveCandle.high;
      last.low = liveCandle.low;
      last.close = liveCandle.close;
      last.volume = liveCandle.volume;
    } else if (!last || liveCandle.time > last.time) {
      all.push({ ...liveCandle });
    }

    candleSeries.update({
      time: liveCandle.time as UTCTimestamp,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
    });
    volumeSeries.update({
      time: liveCandle.time as UTCTimestamp,
      value: liveCandle.volume,
      color:
        liveCandle.close >= liveCandle.open
          ? "rgba(0,192,118,0.4)"
          : "rgba(255,83,83,0.4)",
    });
  }, [liveCandle]);

  const handleBucketClick = useCallback(
    (b: BucketSize) => {
      setActiveWindow(null);
      onBucketChange(b);
    },
    [onBucketChange]
  );

  const handleWindowClick = useCallback(
    (preset: (typeof WINDOW_PRESETS)[number]) => {
      setActiveWindow(preset.id);
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
