import { NextResponse } from "next/server";
import { ensureCsrfToken } from "@/lib/csrf";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const token = await ensureCsrfToken();
  return NextResponse.json({ csrfToken: token });
}
