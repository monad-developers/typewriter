type RpcScope = {
  tag: string;
  silent: boolean;
};

let currentScope: RpcScope | null = null;

export function getCurrentScope() {
  return currentScope;
}

export async function withRpcScope<T>(
  tag: string,
  fn: () => Promise<T>,
  options?: { silent?: boolean },
): Promise<T> {
  const prev = currentScope;
  currentScope = { tag, silent: options?.silent ?? false };
  try {
    return await fn();
  } finally {
    currentScope = prev;
  }
}
