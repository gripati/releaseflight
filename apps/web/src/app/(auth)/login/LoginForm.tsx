"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, Spinner } from "@marquee/ui";

export function LoginForm(): JSX.Element {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  // Fetch a CSRF token on mount; the server sets the cookie + returns the value.
  useEffect(() => {
    void fetch("/api/v1/auth/csrf-token", { credentials: "include" })
      .then((r) => r.json() as Promise<{ csrfToken: string }>)
      .then((d) => setCsrfToken(d.csrfToken))
      .catch(() => setCsrfToken(null));
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = form.get("email")?.toString() ?? "";
    const password = form.get("password")?.toString() ?? "";

    startTransition(() => {
      void (async () => {
        const res = await fetch("/api/v1/auth/login", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: { message?: string; code?: string } }
            | null;
          setError(body?.error?.message ?? "Sign-in failed");
          return;
        }
        const data = (await res.json()) as { redirectTo: string };
        router.push(data.redirectTo);
        router.refresh();
      })();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          disabled={isPending}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          disabled={isPending}
          className="mt-1.5"
        />
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
        >
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" size="lg" disabled={isPending || !csrfToken}>
        {isPending ? <Spinner size={12} /> : "→  Sign in"}
      </Button>
    </form>
  );
}
