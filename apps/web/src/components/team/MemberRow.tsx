"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Stamp, Button, Spinner, Label, cn } from "@marquee/ui";
import { Trash2, SlidersHorizontal } from "lucide-react";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { ConfirmDialog } from "@/components/feedback/ConfirmDialog";

type Role = "OWNER" | "ADMIN" | "MAINTAINER" | "EDITOR" | "VIEWER";

const ROLE_OPTIONS: Role[] = ["OWNER", "ADMIN", "MAINTAINER", "EDITOR", "VIEWER"];

interface AppOption {
  id: string;
  name: string;
}

interface MemberDto {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
  lastLoginAt: string | null;
  allowedAppIds: string[];
}

interface Props {
  tenantSlug: string;
  member: MemberDto;
  apps: AppOption[];
  currentUserId: string;
  currentUserRole: Role;
  canManage: boolean;
  isLastOwner: boolean;
}

function stampVariant(role: Role): "default" | "info" | "success" {
  if (role === "OWNER") return "default";
  if (role === "EDITOR") return "success";
  return "info";
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60).toString()}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600).toString()}h ago`;
  return `${Math.round(sec / 86_400).toString()}d ago`;
}

export function MemberRow({
  tenantSlug,
  member,
  apps,
  currentUserId,
  currentUserRole,
  canManage,
  isLastOwner,
}: Props): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showRoles, setShowRoles] = useState(false);
  const isSelf = member.userId === currentUserId;

  // App-scope editing. Empty selection = access to ALL apps.
  const [editApps, setEditApps] = useState(false);
  const [scope, setScope] = useState<string[]>(member.allowedAppIds);
  // An ADMIN may not edit an OWNER's scope (the API enforces the same rule).
  const canEditApps =
    canManage && apps.length > 0 && (member.role !== "OWNER" || currentUserRole === "OWNER");
  const scopeLabel =
    member.allowedAppIds.length === 0
      ? "All apps"
      : `${member.allowedAppIds.length.toString()} app${member.allowedAppIds.length === 1 ? "" : "s"}`;

  function toggleScope(id: string): void {
    setScope((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function openAppsEditor(): void {
    setScope(member.allowedAppIds);
    setEditApps(true);
  }
  function saveApps(): void {
    startTransition(() => {
      void (async () => {
        const res = await api(`/api/v1/t/${tenantSlug}/members/${member.userId}`, {
          method: "PATCH",
          body: { allowedAppIds: scope },
        });
        setEditApps(false);
        if (!res.ok) {
          toast.error("Could not update app access", { description: res.message });
          return;
        }
        toast.success("App access updated");
        router.refresh();
      })();
    });
  }

  function changeRole(role: Role): void {
    setShowRoles(false);
    startTransition(() => {
      void (async () => {
        const res = await api(
          `/api/v1/t/${tenantSlug}/members/${member.userId}`,
          { method: "PATCH", body: { role } },
        );
        if (!res.ok) toast.error(`Role change failed: ${res.message}`);
        else toast.success(`Role updated to ${role}`);
        router.refresh();
      })();
    });
  }

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmTransfer, setConfirmTransfer] = useState(false);

  // Only a current OWNER can hand the OWNER role to a non-owner member. This
  // promotes the target to OWNER and demotes the caller to ADMIN atomically
  // (see POST /transfer-ownership), distinct from simply adding a co-owner via
  // the role dropdown.
  const canTransfer = currentUserRole === "OWNER" && !isSelf && member.role !== "OWNER";

  function doTransfer(): void {
    startTransition(() => {
      void (async () => {
        const t = toast.loading(`Transferring ownership to ${member.displayName}…`);
        const res = await api(`/api/v1/t/${tenantSlug}/transfer-ownership`, {
          method: "POST",
          body: { userId: member.userId },
        });
        setConfirmTransfer(false);
        if (!res.ok) {
          toast.error("Transfer failed", { id: t, description: res.message });
          return;
        }
        toast.success(`${member.displayName} is now the OWNER`, { id: t });
        router.refresh();
      })();
    });
  }

  function remove(): void {
    setConfirmRemove(true);
  }
  function doRemove(): void {
    startTransition(() => {
      void (async () => {
        const t = toast.loading(isSelf ? "Leaving workspace…" : `Removing ${member.displayName}…`);
        const res = await api(`/api/v1/t/${tenantSlug}/members/${member.userId}`, {
          method: "DELETE",
        });
        setConfirmRemove(false);
        if (!res.ok) {
          toast.error("Remove failed", { id: t, description: res.message });
          return;
        }
        toast.success(isSelf ? "Left workspace" : `${member.displayName} removed`, { id: t });
        if (isSelf) {
          router.push("/account/tenants");
          return;
        }
        router.refresh();
      })();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--ink-primary)] text-[12px] font-medium text-[var(--surface-paper)]">
        {member.displayName.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-body text-[13px]">
          {member.displayName}
          {isSelf && (
            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              (you)
            </span>
          )}
        </p>
        <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">{member.email}</p>
      </div>
      <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
        Joined {relTime(member.joinedAt)} · Active {relTime(member.lastLoginAt)}
      </span>
      <button
        type="button"
        onClick={canEditApps ? openAppsEditor : undefined}
        disabled={!canEditApps || pending}
        title={canEditApps ? "Edit app access" : undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--stroke-default)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]",
          canEditApps && "cursor-pointer hover:bg-[var(--surface-tinted)]",
        )}
      >
        <SlidersHorizontal size={11} />
        {scopeLabel}
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => canManage && !isLastOwner && setShowRoles((v) => !v)}
          disabled={!canManage || isLastOwner || pending}
          className={cn(
            "rounded-[var(--radius-xs)] transition-opacity disabled:cursor-default disabled:opacity-100",
            canManage && !isLastOwner && "cursor-pointer hover:opacity-80",
          )}
        >
          <Stamp variant={stampVariant(member.role)}>{member.role}</Stamp>
        </button>
        {showRoles && (
          <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-[var(--radius-xs)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] shadow-[var(--shadow-popover)]">
            {ROLE_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                disabled={r === member.role || (r === "OWNER" && currentUserRole !== "OWNER")}
                onClick={() => changeRole(r)}
                className="flex w-full items-center justify-between px-3 py-2 font-mono text-[11px] hover:bg-[var(--surface-tinted)] disabled:opacity-30"
              >
                <span>{r}</span>
                {r === member.role && <span className="text-[var(--ink-tertiary)]">·</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {canTransfer && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmTransfer(true)}
          disabled={pending}
          className="font-mono text-[10px] uppercase tracking-[0.08em]"
        >
          Make owner
        </Button>
      )}
      {(canManage || isSelf) && !isLastOwner && (
        <Button
          variant="ghost"
          size="icon"
          onClick={remove}
          aria-label={isSelf ? "Leave workspace" : "Remove member"}
          disabled={pending}
        >
          {pending ? <Spinner size={12} /> : <Trash2 size={12} />}
        </Button>
      )}
      <ConfirmDialog
        open={confirmTransfer}
        onClose={() => !pending && setConfirmTransfer(false)}
        onConfirm={doTransfer}
        title={`Transfer ownership to ${member.displayName}?`}
        description="They become the OWNER with full control, including workspace deletion and billing. You will be demoted to ADMIN. This cannot be undone by you afterwards."
        confirmLabel="Transfer ownership"
        pending={pending}
      />
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => !pending && setConfirmRemove(false)}
        onConfirm={doRemove}
        title={isSelf ? "Leave this workspace?" : `Remove ${member.displayName}?`}
        description={
          isSelf
            ? "You will lose access to apps, credentials, and history in this workspace."
            : "They lose access immediately. Their audit-log entries stay."
        }
        confirmLabel={isSelf ? "Leave" : "Remove"}
        pending={pending}
      />
      <Sheet
        open={editApps}
        onClose={() => !pending && setEditApps(false)}
        title={`App access · ${member.displayName}`}
        subtitle="Leave all unchecked to grant access to every app"
        width={520}
      >
        <div className="space-y-4">
          <div className="grid max-h-[50vh] grid-cols-1 gap-1 overflow-y-auto rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-1.5">
            {apps.map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 hover:bg-[var(--surface-tinted)]"
              >
                <input
                  type="checkbox"
                  checked={scope.includes(a.id)}
                  onChange={() => toggleScope(a.id)}
                />
                <span className="font-body text-[12px]">{a.name}</span>
              </label>
            ))}
          </div>
          <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
            {scope.length === 0
              ? "All apps"
              : `${scope.length.toString()} app${scope.length === 1 ? "" : "s"}`}
          </Label>
          <div className="flex justify-end gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
            <Button variant="ghost" onClick={() => setEditApps(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveApps} disabled={pending}>
              {pending ? <Spinner size={12} /> : "Save"}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
