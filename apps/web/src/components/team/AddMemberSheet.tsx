"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Input, Label, Spinner, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

type Role = "OWNER" | "ADMIN" | "MAINTAINER" | "EDITOR" | "VIEWER";

interface AppOption {
  id: string;
  name: string;
}

const BASE_ROLES: { id: Role; label: string; description: string }[] = [
  { id: "ADMIN", label: "Admin", description: "Full access except billing" },
  { id: "MAINTAINER", label: "Maintainer", description: "Credentials + connect apps" },
  { id: "EDITOR", label: "Editor", description: "Metadata edit + push" },
  { id: "VIEWER", label: "Viewer", description: "Read-only" },
];

export function AddMemberSheet({
  tenantSlug,
  apps,
  canGrantOwner,
}: {
  tenantSlug: string;
  apps: AppOption[];
  canGrantOwner: boolean;
}): JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("EDITOR");
  // Empty selection = access to ALL apps in the workspace.
  const [allowedAppIds, setAllowedAppIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const roles = canGrantOwner
    ? [{ id: "OWNER" as Role, label: "Owner", description: "Full control, including deletion" }, ...BASE_ROLES]
    : BASE_ROLES;

  function reset(): void {
    setEmail("");
    setDisplayName("");
    setPassword("");
    setRole("EDITOR");
    setAllowedAppIds([]);
    setError(null);
  }
  function close(): void {
    reset();
    setOpen(false);
  }
  function toggleApp(id: string): void {
    setAllowedAppIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function submit(): void {
    setError(null);
    startTransition(() => {
      void (async () => {
        const t = toast.loading("Creating member…");
        const res = await api<{ ok: boolean; userId: string; createdNewUser: boolean }>(
          `/api/v1/t/${tenantSlug}/members`,
          {
            method: "POST",
            // Omit an empty password so adding an EXISTING user (whose password
            // is left untouched) passes the min(12) rule, which only applies to
            // brand-new accounts.
            body: { email, displayName, role, allowedAppIds, ...(password ? { password } : {}) },
          },
        );
        if (!res.ok) {
          toast.error("Could not add member", { id: t, description: res.message });
          setError(res.message);
          return;
        }
        toast.success(`Added ${displayName || email}`, {
          id: t,
          description: res.data.createdNewUser
            ? "They must change the password on first sign-in."
            : "Existing user added to this workspace.",
        });
        router.refresh();
        close();
      })();
    });
  }

  return (
    <>
      <Button variant="primary" size="md" onClick={() => setOpen(true)}>
        <Plus size={14} /> Add member
      </Button>
      <Sheet
        open={open}
        onClose={close}
        title="Add a member"
        subtitle="You set their initial password; they change it on first sign-in"
        width={560}
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              className="mt-1.5"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="password">Initial password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1 font-body text-[11px] text-[var(--ink-tertiary)]">
              At least 12 characters. Ignored if this email already has an account.
            </p>
          </div>
          <fieldset>
            <Label>Role</Label>
            <div className="mt-1.5 grid grid-cols-1 gap-1.5">
              {roles.map((r) => (
                <label
                  key={r.id}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-xs)] border px-3 py-2.5",
                    role === r.id
                      ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                      : "border-[var(--stroke-default)] hover:bg-[var(--surface-tinted)]",
                  )}
                >
                  <div>
                    <span className="block font-body text-[13px] font-medium">{r.label}</span>
                    <span className="block font-body text-[11px] text-[var(--ink-secondary)]">
                      {r.description}
                    </span>
                  </div>
                  <input
                    type="radio"
                    name="role"
                    value={r.id}
                    checked={role === r.id}
                    onChange={() => setRole(r.id)}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <Label>App access</Label>
            <p className="mt-0.5 font-body text-[11px] text-[var(--ink-tertiary)]">
              Leave all unchecked to grant access to every app. Select specific apps to restrict.
            </p>
            {apps.length === 0 ? (
              <p className="mt-1.5 font-body text-[12px] text-[var(--ink-tertiary)]">
                No apps in this workspace yet.
              </p>
            ) : (
              <div className="mt-1.5 grid max-h-44 grid-cols-1 gap-1 overflow-y-auto rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-1.5">
                {apps.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 hover:bg-[var(--surface-tinted)]"
                  >
                    <input
                      type="checkbox"
                      checked={allowedAppIds.includes(a.id)}
                      onChange={() => toggleApp(a.id)}
                    />
                    <span className="font-body text-[12px]">{a.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              {allowedAppIds.length === 0
                ? "All apps"
                : `${allowedAppIds.length.toString()} app${allowedAppIds.length === 1 ? "" : "s"}`}
            </p>
          </fieldset>
          {error && (
            <p
              role="alert"
              className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
            <Button variant="ghost" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={!email || !displayName || pending}
            >
              {pending ? <Spinner size={12} /> : "Create member →"}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
