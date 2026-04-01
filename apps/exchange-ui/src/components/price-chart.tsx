"use client";

import { useEffect, useRef } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { candlesOptions } from "~/lib/queries";
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  UTCTimestamp,
  type ISeriesApi,
  type SeriesType,
} from "lightweight-charts";

export function PriceChart({ instrument }: { instrument: string }) {
  const { data: candles } = useSuspenseQuery(candlesOptions(instrument));
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const prevInstrumentRef = useRef(instrument);
  const prevCandleLenRef = useRef(0);

  // Create chart once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#808080",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00c076",
      downColor: "#ff5353",
      borderUpColor: "#00c076",
      borderDownColor: "#ff5353",
      wickUpColor: "#00c076",
      wickDownColor: "#ff5353",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && chartRef.current) {
        const { width, height } = entry.contentRect;
        chartRef.current.applyOptions({ width, height });
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Update data when candles or instrument changes
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;

    const mapped = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const instrumentChanged = prevInstrumentRef.current !== instrument;

    if (instrumentChanged) {
      // Full replacement on instrument switch
      series.setData(mapped);
      chartRef.current?.timeScale().fitContent();
      prevInstrumentRef.current = instrument;
      prevCandleLenRef.current = candles.length;
    } else {
      // Incremental: update the last candle
      const last = mapped[mapped.length - 1];
      if (last) {
        // If a new candle was added, set full data once to include it
        if (candles.length !== prevCandleLenRef.current) {
          series.setData(mapped);
          prevCandleLenRef.current = candles.length;
        } else {
          series.update(last);
        }
      }
    }
  }, [candles, instrument]);

  return <div ref={containerRef} className="w-full h-full" />;
}
