import { useSyncExternalStore } from "react";

export type RequestLogEntry = {
  id: number;
  method: string;
  path: string;
  tag: string | null;
  duration: number;
  status: "ok" | "error";
  timestamp: number;
};

const MAX_ENTRIES = 200;
let entries: RequestLogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

export function pushEntry(entry: Omit<RequestLogEntry, "id" | "timestamp">) {
  entries = [
    { ...entry, id: nextId++, timestamp: Date.now() },
    ...entries,
  ].slice(0, MAX_ENTRIES);
  emitChange();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return entries;
}

export function useRequestLog() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
