import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { destroySession, clearSessionCookie, SESSION_COOKIE_NAME } from "@/lib/session";

export async function POST(): Promise<Response> {
  // Logout is a plain HTML form POST, so it can't attach the x-csrf-token
  // header. Enforce same-origin instead: reject a cross-origin Origin. Together
  // with the SameSite=Lax session cookie this blocks cross-site forced-logout.
  const h = await headers();
  const origin = h.get("origin");
  if (origin) {
    const appHost = new URL(process.env.APP_URL ?? "http://localhost:3000").host;
    let originHost: string | null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== appHost) {
      return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
    }
  }

  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) await destroySession(token);
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", process.env.APP_URL ?? "http://localhost:3000"), {
    status: 303,
  });
}
