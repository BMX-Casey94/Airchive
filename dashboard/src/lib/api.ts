const apiBaseUrl =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

export { apiBaseUrl };

/**
 * Generic SWR-compatible fetcher. Attaches a JWT bearer token from
 * sessionStorage when available so authenticated endpoints work seamlessly.
 */
export async function fetcher<T = unknown>(url: string): Promise<T> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (typeof window !== "undefined") {
    const token = sessionStorage.getItem("airchive_token");
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "Unknown error");
    const error = new Error(
      `API ${res.status}: ${res.statusText} — ${errorBody}`,
    );
    (error as Error & { status: number }).status = res.status;
    throw error;
  }

  return res.json() as Promise<T>;
}

/**
 * POST helper for mutation endpoints (e.g. acknowledge alerts).
 */
export async function postApi<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (typeof window !== "undefined") {
    const token = sessionStorage.getItem("airchive_token");
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "Unknown error");
    const error = new Error(
      `API ${res.status}: ${res.statusText} — ${errorBody}`,
    );
    (error as Error & { status: number }).status = res.status;
    throw error;
  }

  return res.json() as Promise<T>;
}
