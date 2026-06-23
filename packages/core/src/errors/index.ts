/**
 * Domain error hierarchy. The HTTP layer maps these to status codes.
 * Each error has a stable `code` for client-side handling.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "CREDENTIAL_INVALID"
  | "CREDENTIAL_EXPIRED"
  | "INTERNAL_ERROR"
  | "UNSUPPORTED_LOCALE"
  | "FILE_TOO_LARGE"
  | "INVALID_DIMENSIONS"
  | "DIRTY_OVERWRITE_BLOCKED"
  | "TENANT_LIMIT_EXCEEDED"
  | "TENANT_SUSPENDED"
  | "SEAT_LIMIT_REACHED"
  | "BILLING_SUSPENDED";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;
  public readonly retryable: boolean;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    httpStatus: number;
    details?: Record<string, unknown>;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "AppError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    if (opts.details !== undefined) this.details = opts.details;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "VALIDATION_ERROR", message, httpStatus: 400, ...(details && { details }) });
    this.name = "ValidationError";
  }
}

export class AuthRequiredError extends AppError {
  constructor(message = "Authentication required") {
    super({ code: "AUTH_REQUIRED", message, httpStatus: 401 });
    this.name = "AuthRequiredError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super({ code: "FORBIDDEN", message, httpStatus: 403 });
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super({ code: "NOT_FOUND", message, httpStatus: 404 });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "CONFLICT", message, httpStatus: 409, ...(details && { details }) });
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super({
      code: "RATE_LIMITED",
      message: `Rate limit exceeded. Retry after ${retryAfterSeconds.toString()}s.`,
      httpStatus: 429,
      details: { retryAfter: retryAfterSeconds },
      retryable: true,
    });
    this.name = "RateLimitError";
  }
}

export class CredentialInvalidError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "CREDENTIAL_INVALID", message, httpStatus: 401, ...(details && { details }) });
    this.name = "CredentialInvalidError";
  }
}

export class UpstreamError extends AppError {
  constructor(
    provider: "apple" | "google" | "firebase",
    message: string,
    opts: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super({
      code: "UPSTREAM_ERROR",
      message: `[${provider}] ${message}`,
      httpStatus: opts.httpStatus ?? 502,
      retryable: opts.retryable ?? false,
      details: { provider, ...opts.details },
    });
    this.name = "UpstreamError";
  }
}

export class TenantSuspendedError extends AppError {
  constructor(reason: string) {
    super({
      code: "TENANT_SUSPENDED",
      message: `Workspace suspended: ${reason}`,
      httpStatus: 403,
    });
    this.name = "TenantSuspendedError";
  }
}

export class TenantLimitExceededError extends AppError {
  constructor(metric: string, current: number, max: number) {
    super({
      code: "TENANT_LIMIT_EXCEEDED",
      message: `${metric} limit reached (${current.toString()}/${max.toString()})`,
      httpStatus: 402,
      details: { metric, current, max },
    });
    this.name = "TenantLimitExceededError";
  }
}

/**
 * The subscription's member-seat cap is full. Carries the count + a
 * `manageBillingUrl` (the Polar Customer Portal) so the UI can offer "Add seats".
 * 402 Payment Required — the action is allowed once the buyer raises the seat
 * quantity in Polar (which lifts the cap on the next license-token refresh).
 */
export class SeatLimitReachedError extends AppError {
  constructor(used: number, seats: number, manageBillingUrl?: string | null) {
    super({
      code: "SEAT_LIMIT_REACHED",
      message: `Member seat limit reached (${used.toString()}/${seats.toString()}). Add seats or remove a member.`,
      httpStatus: 402,
      details: { used, seats, manageBillingUrl: manageBillingUrl ?? null },
    });
    this.name = "SeatLimitReachedError";
  }
}

/**
 * The subscription is on hold (payment lapsed past the grace window, or the
 * license was suspended/revoked). The instance is in read-only freeze: GETs and
 * the billing-fix flow stay open, mutations are blocked until payment resumes.
 */
export class BillingSuspendedError extends AppError {
  constructor(manageBillingUrl?: string | null) {
    super({
      code: "BILLING_SUSPENDED",
      message:
        "Your subscription is on hold. Update billing to resume — the workspace is read-only until then.",
      httpStatus: 402,
      details: { manageBillingUrl: manageBillingUrl ?? null },
    });
    this.name = "BillingSuspendedError";
  }
}
