import { useEffect, useRef, useState } from "react";

const PING_COUNT = 10;

export function PingTest() {
  const [results, setResults] = useState<number[]>([]);
  const [running, setRunning] = useState(false);
  const warmedUp = useRef(false);

  // Prewarm: fire one unmeasured request on mount so the TCP connection and
  // any server-side lazy init are done before the first measured ping.
  useEffect(() => {
    if (warmedUp.current) return;
    warmedUp.current = true;
    fetch("/ping").catch(() => {});
  }, []);

  async function runPings() {
    setRunning(true);
    setResults([]);
    const times: number[] = [];
    for (let i = 0; i < PING_COUNT; i++) {
      const start = performance.now();
      await fetch("/ping");
      const rtt = performance.now() - start;
      times.push(rtt);
      console.log(`ping ${i + 1}/${PING_COUNT}: ${rtt.toFixed(2)}ms`);
      setResults([...times]);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`ping summary — avg: ${avg.toFixed(2)}ms  min: ${min.toFixed(2)}ms  max: ${max.toFixed(2)}ms`);
    setRunning(false);
  }

  const avg = results.length
    ? results.reduce((a, b) => a + b, 0) / results.length
    : null;

  return (
    <div className="flex items-center gap-4 text-sm">
      <button
        type="button"
        onClick={runPings}
        disabled={running}
        className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? "Pinging..." : "Ping server"}
      </button>
      {results.length > 0 && (
        <span className="text-gray-500">
          {results.length}/{PING_COUNT} — avg: {avg?.toFixed(2)}ms — last:{" "}
          {results[results.length - 1].toFixed(2)}ms
        </span>
      )}
    </div>
  );
}
