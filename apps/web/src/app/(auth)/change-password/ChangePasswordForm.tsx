"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";

export function ChangePasswordForm({ forced }: { forced: boolean }): JSX.Element {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(): void {
    setError(null);
    if (newPassword !== confirm) {
      setError("New passwords do not match");
      return;
    }
    start(() => {
      void (async () => {
        const res = await api<{ ok: boolean; redirectTo?: string }>(
          "/api/v1/auth/change-password",
          { method: "POST", body: { currentPassword, newPassword } },
        );
        if (!res.ok) {
          setError(res.message);
          return;
        }
        router.push(res.data.redirectTo ?? "/account/tenants");
        router.refresh();
      })();
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mt-8 flex flex-col gap-4"
    >
      <div>
        <Label htmlFor="current-password">
          {forced ? "Temporary password" : "Current password"}
        </Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoFocus
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={12}
          className="mt-1.5"
        />
        <p className="mt-1 font-body text-[11px] text-[var(--ink-tertiary)]">
          At least 12 characters. Stored as an Argon2id hash.
        </p>
      </div>
      <div>
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={12}
          className="mt-1.5"
        />
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
        >
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={pending}>
        {pending ? <Spinner size={12} /> : "→  Save password"}
      </Button>
    </form>
  );
}
