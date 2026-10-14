import superjson from "superjson";

export type RequestParams = {
  method?: "GET" | "POST";
  body?: unknown;
  cache?: RequestCache;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Servers send errors as superjson `{ error }` or as plain text.
function errorMessage(text: string, path: string): string {
  try {
    const data = superjson.parse(text);
    if (data !== null && typeof data === "object" && "error" in data) {
      return String(data.error);
    }
  } catch {}
  return text === "" ? `Request failed: ${path}` : text;
}

export async function request<T>(
  path: string,
  params: RequestParams = {},
): Promise<T> {
  const response = await fetch(path, {
    method: params.method ?? "GET",
    cache: params.cache,
    headers:
      params.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      params.body === undefined ? undefined : superjson.stringify(params.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(errorMessage(text, path), response.status);
  }
  return (text === "" ? undefined : superjson.parse(text)) as T;
}
