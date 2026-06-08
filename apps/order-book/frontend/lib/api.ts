import superjson from "superjson";

type RequestParams = {
  method?: "GET" | "POST";
  body?: unknown;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  params: RequestParams = {},
): Promise<T> {
  const method = params.method ?? "GET";
  const res = await fetch(path, {
    method,
    headers:
      params.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      params.body === undefined ? undefined : superjson.stringify(params.body),
  });
  const text = await res.text();
  const data = text === "" ? undefined : superjson.parse(text);
  if (!res.ok) {
    const error =
      data !== null && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Request failed: ${path}`;
    throw new ApiError(error, res.status);
  }
  return data as T;
}
