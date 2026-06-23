/**
 * Response wrapper test — covers withApiErrors error mapping:
 *   - AppError → http status + JSON body via toJSON
 *   - ZodError → 400 VALIDATION_ERROR with issues
 *   - Anything else → 500 INTERNAL_ERROR (and logger.error called)
 *   - Happy path → passes the original response through unchanged
 */
import { describe, expect, test, vi } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ForbiddenError, NotFoundError, ValidationError } from "@marquee/core";

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { jsonError, withApiErrors } from "../responses";

describe("jsonError", () => {
  test("creates a NextResponse with the given status + body", async () => {
    const res = jsonError(418, { hint: "teapot" });
    expect(res.status).toBe(418);
    const body = (await res.json()) as { hint: string };
    expect(body.hint).toBe("teapot");
  });
});

describe("withApiErrors", () => {
  test("returns the underlying response on success", async () => {
    const wrapped = withApiErrors(async () => NextResponse.json({ a: 1 }, { status: 201 }));
    const res = await wrapped();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ a: 1 });
  });

  test("ForbiddenError → 403 with JSON envelope", async () => {
    const wrapped = withApiErrors(async () => {
      throw new ForbiddenError("denied");
    });
    const res = await wrapped();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("denied");
  });

  test("NotFoundError → 404", async () => {
    const wrapped = withApiErrors(async () => {
      throw new NotFoundError("nope");
    });
    const res = await wrapped();
    expect(res.status).toBe(404);
  });

  test("ValidationError → 400", async () => {
    const wrapped = withApiErrors(async () => {
      throw new ValidationError("bad");
    });
    const res = await wrapped();
    expect(res.status).toBe(400);
  });

  test("ZodError → 400 VALIDATION_ERROR with issues", async () => {
    const schema = z.object({ name: z.string().min(3) });
    const wrapped = withApiErrors(async () => {
      schema.parse({ name: "a" });
      return NextResponse.json({});
    });
    const res = await wrapped();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { issues: unknown[] } } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  test("Unknown thrown values → 500 INTERNAL_ERROR (no leak of message)", async () => {
    const wrapped = withApiErrors(async () => {
      throw new Error("internal-detail");
    });
    const res = await wrapped();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("internal-detail");
  });
});
