import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin proxy for the JWT-protected gateway alert test.
 *
 * The browser never holds operator credentials or a long-lived token. This
 * route mints a short-lived JWT via the gateway using server-only
 * OPERATOR_USERNAME / OPERATOR_PASSWORD, then forwards the test request on the
 * Docker network (GATEWAY_INTERNAL_URL).
 */
function gatewayBaseUrl(): string {
  return (
    process.env.GATEWAY_INTERNAL_URL
    ?? process.env.GATEWAY_URL
    ?? "http://gateway:4000"
  ).replace(/\/+$/, "");
}

export async function POST(request: Request): Promise<Response> {
  const username = (process.env.OPERATOR_USERNAME ?? "").trim();
  const password = process.env.OPERATOR_PASSWORD ?? "";

  if (!username || !password) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Operator credentials are not configured on the dashboard "
          + "(set OPERATOR_USERNAME and OPERATOR_PASSWORD).",
      },
      { status: 503 },
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const base = gatewayBaseUrl();

  try {
    const tokenRes = await fetch(`${base}/api/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ username, password }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    const tokenJson = (await tokenRes.json().catch(() => null)) as {
      success?: boolean;
      data?: { token?: string };
      error?: string;
    } | null;

    if (!tokenRes.ok || !tokenJson?.data?.token) {
      return NextResponse.json(
        {
          success: false,
          error:
            tokenJson?.error
            ?? `Could not authenticate with gateway (${tokenRes.status})`,
        },
        { status: tokenRes.status === 401 ? 503 : tokenRes.status },
      );
    }

    const testRes = await fetch(`${base}/api/alerts/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${tokenJson.data.token}`,
      },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    const testJson = await testRes.json().catch(() => ({
      success: false,
      error: `Alert test failed (${testRes.status})`,
    }));

    return NextResponse.json(testJson, { status: testRes.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Alert test proxy failed";
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 },
    );
  }
}
