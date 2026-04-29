import { useSyncExternalStore } from "react";

export type RpcLogEntry = {
  id: number;
  method: string;
  tag: string | null;
  duration: number;
  status: "ok" | "error";
  timestamp: number;
};

const MAX_ENTRIES = 200;
let entries: RpcLogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

export function pushEntry(entry: Omit<RpcLogEntry, "id" | "timestamp">) {
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

export function useRpcLog() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
