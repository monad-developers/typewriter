"use client";

import { useEffect, useRef } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { candlesOptions } from "~/lib/queries";
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  UTCTimestamp
} from "lightweight-charts";

export function PriceChart({ instrument }: { instrument: string }) {
  const { data: candles } = useSuspenseQuery(candlesOptions(instrument));
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#808080"
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

    chart.addSeries(CandlestickSeries, {
      upColor: "#00c076",
      downColor: "#ff5353",
      borderUpColor: "#00c076",
      borderDownColor: "#ff5353",
      wickUpColor: "#00c076",
      wickDownColor: "#ff5353",
    }).setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    chart.timeScale().fitContent();
    chartRef.current = chart;

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
    };
  }, [candles]);

  return <div ref={containerRef} className="w-full h-full" />;
}
