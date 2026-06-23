"use client";

/**
 * Notification bell + anchored popover.
 *
 * Design choices:
 *   • POPOVER, not drawer — anchored fixed-position below the bell
 *     button (rect-measured on open + on resize / scroll). The popover
 *     is small, scoped, and doesn't take over the screen.
 *   • No backdrop blur or dark overlay — a transparent click-outside
 *     layer just catches dismiss intent.
 *   • Two-row notification cards — title row (dot + title + time) and
 *     a single muted line (app · message). Expandable "Why?" reveals
 *     analyst details. Click anywhere on the card → navigate +
 *     auto-mark-read.
 *   • Theme-aware via design-system tokens. No dark: variants.
 *
 * Polls the feed every 60s while the tab is visible so the badge
 * stays warm without a websocket.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Bell, ChevronDown, RefreshCw, X } from "lucide-react";
import { cn } from "@marquee/ui";

type Severity = "info" | "warning" | "danger";

interface NotificationRow {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  trackedKeywordId: string | null;
  competitorId: string | null;
  agentInterpretation: string | null;
  agentProbableCause: string | null;
  agentNextAction: string | null;
  agentConfidence: number | null;
  readAt: string | null;
  createdAt: string;
  app: { id: string; appName: string; bundleId: string; platform: "IOS" | "ANDROID" };
}

interface FeedResponse {
  notifications: NotificationRow[];
  totalUnread: number;
}

interface NotificationBellProps {
  tenantSlug: string;
}

const POPOVER_WIDTH = 380;
const POPOVER_OFFSET_TOP = 8; // px below the bell

export function NotificationBell({ tenantSlug }: NotificationBellProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<Severity | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  // Portal mount-gate: createPortal can't run during SSR, so wait
  // until after first client render to allow the portal target
  // (document.body) to exist. Avoids hydration mismatch + SSR errors.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // ── Fetching ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL("/api/v1/notifications", window.location.origin);
      if (severityFilter) url.searchParams.set("severity", severityFilter);
      if (unreadOnly) url.searchParams.set("unread", "true");
      url.searchParams.set("limit", "100");
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as FeedResponse;
      setFeed(data);
    } finally {
      setLoading(false);
    }
  }, [severityFilter, unreadOnly]);

  // Initial load + 60s polling. Pauses when tab hidden so we don't
  // burn cycles on backgrounded tabs.
  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // ── Anchor measurement ────────────────────────────────────────
  // Recompute popover position when open / on resize / on scroll.
  // `position: fixed` so scroll doesn't drag the popover off-screen
  // away from its anchor button.
  const updateAnchor = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setAnchor({
      top: r.bottom + POPOVER_OFFSET_TOP,
      right: Math.max(8, window.innerWidth - r.right),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [open, updateAnchor]);

  // ESC + click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return; // click on bell handled by button itself
      if (popoverRef.current?.contains(target)) return; // click inside popover stays open
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  // ── Mutations ─────────────────────────────────────────────────
  const markRead = useCallback(async (id: string) => {
    const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
    const csrf = (await csrfRes.json()) as { csrfToken: string };
    await fetch(`/api/v1/notifications/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken },
      body: JSON.stringify({ read: true }),
    });
    setFeed((prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.map((n) =>
              n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
            ),
            totalUnread: Math.max(0, prev.totalUnread - 1),
          }
        : prev,
    );
  }, []);

  const markAllRead = useCallback(async () => {
    if (!feed) return;
    const unread = feed.notifications.filter((n) => n.readAt === null);
    if (unread.length === 0) return;
    const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
    const csrf = (await csrfRes.json()) as { csrfToken: string };
    await Promise.all(
      unread.map((n) =>
        fetch(`/api/v1/notifications/${n.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken },
          body: JSON.stringify({ read: true }),
        }),
      ),
    );
    await load();
  }, [feed, load]);

  // ── Computed ──────────────────────────────────────────────────
  const grouped = useMemo(() => groupByDate(feed?.notifications ?? []), [feed]);

  // Bell badge tone follows the loudest unread severity.
  const badgeClass = feed && feed.totalUnread > 0
    ? feed.notifications.some((n) => !n.readAt && n.severity === "danger")
      ? "pill-negative"
      : feed.notifications.some((n) => !n.readAt && n.severity === "warning")
        ? "pill-warning"
        : "pill-info"
    : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          feed && feed.totalUnread > 0
            ? `Notifications — ${feed.totalUnread.toString()} unread`
            : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex h-8 w-8 items-center justify-center rounded-[var(--radius-xs)]",
          "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
          open ? "bg-[var(--surface-tinted)]" : "",
        )}
      >
        <Bell size={16} />
        {badgeClass && feed && feed.totalUnread > 0 ? (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
              badgeClass,
            )}
          >
            {feed.totalUnread > 99 ? "99+" : feed.totalUnread.toString()}
          </span>
        ) : null}
      </button>

      {open && mounted
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Notifications"
              style={{
                top: anchor.top,
                right: anchor.right,
                width: POPOVER_WIDTH,
                maxHeight: "min(70vh, 640px)",
              }}
              className={cn(
                // Portalled to document.body so the popover escapes
                // the topbar's sticky stacking context. z-[100] inside
                // the body's stacking context dominates everything.
                "fixed z-[100] flex flex-col overflow-hidden",
                "rounded-[var(--radius-sm)] border border-[var(--stroke-default)]",
                // Very light shadow — just enough to lift the popover off
                // the page; no heavy "modal" look.
                "bg-[var(--surface-elevated)] shadow-[0_2px_8px_rgba(0,0,0,0.05)]",
              )}
            >
          {/* Header — solid background, no blur, no overlay */}
          <header className="flex items-center gap-2 border-b border-[var(--stroke-default)] px-3 py-2.5">
            <span className="font-display text-[14px] leading-none">Notifications</span>
            {(feed?.totalUnread ?? 0) > 0 ? (
              <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
                {(feed?.totalUnread ?? 0).toString()} unread
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Refresh"
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-[var(--radius-xs)] text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-xs)] text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
            >
              <X size={12} />
            </button>
          </header>

          {/* Filter row */}
          <div className="flex items-center gap-1 border-b border-[var(--stroke-default)] bg-[var(--surface-paper)] px-3 py-1.5">
            <FilterChip active={severityFilter === null} onClick={() => setSeverityFilter(null)}>
              All
            </FilterChip>
            <FilterChip
              active={severityFilter === "danger"}
              tone="negative"
              onClick={() =>
                setSeverityFilter(severityFilter === "danger" ? null : "danger")
              }
            >
              Danger
            </FilterChip>
            <FilterChip
              active={severityFilter === "warning"}
              tone="warning"
              onClick={() =>
                setSeverityFilter(severityFilter === "warning" ? null : "warning")
              }
            >
              Warning
            </FilterChip>
            <FilterChip
              active={severityFilter === "info"}
              tone="info"
              onClick={() =>
                setSeverityFilter(severityFilter === "info" ? null : "info")
              }
            >
              Info
            </FilterChip>
            <button
              type="button"
              onClick={() => setUnreadOnly((v) => !v)}
              className={cn(
                "ml-auto font-mono text-[9px] uppercase tracking-[0.04em]",
                unreadOnly
                  ? "text-[var(--ink-primary)]"
                  : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {unreadOnly ? "✓ unread" : "unread"}
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {grouped.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px] text-[var(--ink-tertiary)]">
                Nothing here yet.
              </div>
            ) : (
              grouped.map(({ label, items }) => (
                <DateGroup
                  key={label}
                  label={label}
                  items={items}
                  tenantSlug={tenantSlug}
                  onMarkRead={(id) => void markRead(id)}
                  onClose={() => setOpen(false)}
                />
              ))
            )}
          </div>

          {/* Footer */}
          {(feed?.totalUnread ?? 0) > 0 ? (
            <footer className="border-t border-[var(--stroke-default)] px-3 py-2">
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="w-full rounded-[var(--radius-xs)] py-1 text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
              >
                Mark all as read
              </button>
            </footer>
          ) : null}
        </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Date grouping
// ─────────────────────────────────────────────────────────────────────

function groupByDate(
  notifications: NotificationRow[],
): { label: string; items: NotificationRow[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const buckets = new Map<string, NotificationRow[]>();
  for (const n of notifications) {
    const created = new Date(n.createdAt);
    const day = new Date(created);
    day.setHours(0, 0, 0, 0);
    let label: string;
    if (day.getTime() === today.getTime()) label = "Today";
    else if (day.getTime() === yesterday.getTime()) label = "Yesterday";
    else label = day.toISOString().slice(0, 10);
    const slot = buckets.get(label) ?? [];
    slot.push(n);
    buckets.set(label, slot);
  }
  return Array.from(buckets.entries()).map(([label, items]) => ({ label, items }));
}

function DateGroup({
  label,
  items,
  tenantSlug,
  onMarkRead,
  onClose,
}: {
  label: string;
  items: NotificationRow[];
  tenantSlug: string;
  onMarkRead: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <section className="border-b border-[var(--stroke-soft)] last:border-b-0">
      {/* Plain label — no sticky, no blur, no overlay. */}
      <div className="bg-[var(--surface-paper)] px-3 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
        {label}
        <span className="ml-1.5 font-normal">· {items.length.toString()}</span>
      </div>
      <ul>
        {items.map((n) => (
          <NotificationCard
            key={n.id}
            notification={n}
            tenantSlug={tenantSlug}
            onMarkRead={() => onMarkRead(n.id)}
            onClose={onClose}
          />
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// One notification — 2-row layout: title row + meta row + collapsible
// ─────────────────────────────────────────────────────────────────────

function NotificationCard({
  notification,
  tenantSlug,
  onMarkRead,
  onClose,
}: {
  notification: NotificationRow;
  tenantSlug: string;
  onMarkRead: () => void;
  onClose: () => void;
}): JSX.Element {
  const unread = notification.readAt === null;
  const [showDetail, setShowDetail] = useState(false);

  const hasDetail =
    notification.agentInterpretation !== null ||
    notification.agentProbableCause !== null ||
    notification.agentNextAction !== null;

  // Tagged-notification routing precedence:
  //   • trackedKeywordId → keyword detail page (rank-movement alarms)
  //   • competitorId    → competitors panel (metadata-change events)
  //   • neither         → Pulse (everything else, e.g. funnel anomalies)
  const href = notification.trackedKeywordId
    ? `/t/${tenantSlug}/apps/${notification.app.id}/keywords/${notification.trackedKeywordId}`
    : notification.competitorId
      ? `/t/${tenantSlug}/apps/${notification.app.id}/keywords/competitors`
      : `/t/${tenantSlug}/apps/${notification.app.id}/pulse`;

  const dotColor =
    notification.severity === "danger"
      ? "var(--status-danger)"
      : notification.severity === "warning"
        ? "var(--status-warning)"
        : "var(--signal)";

  return (
    <li
      className={cn(
        "border-b border-[var(--stroke-soft)] last:border-b-0",
        unread ? "" : "opacity-60",
      )}
    >
      <Link
        href={href}
        onClick={() => {
          onMarkRead();
          onClose();
        }}
        className="block px-3 py-2 hover:bg-[var(--surface-tinted)]/60"
      >
        {/* Row 1 — dot + title + time */}
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{
              background: unread ? dotColor : "transparent",
              boxShadow: unread ? "none" : "inset 0 0 0 1px var(--ink-tertiary)",
            }}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-tight">
            {notification.title}
          </span>
          <span className="whitespace-nowrap font-mono text-[9px] text-[var(--ink-tertiary)]">
            {formatRelative(notification.createdAt)}
          </span>
        </div>
        {/* Row 2 — single muted line: app · message (truncate) */}
        <p className="mt-0.5 truncate pl-3.5 text-[11px] leading-snug text-[var(--ink-tertiary)]">
          <span className="text-[var(--ink-secondary)]">{notification.app.appName}</span>
          {" · "}
          {notification.agentInterpretation ?? notification.message}
        </p>
      </Link>

      {/* Optional "Why?" reveal — only when analyst data exists. */}
      {hasDetail ? (
        <div className="px-3 pb-2 pl-[26px]">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetail((v) => !v);
            }}
            aria-expanded={showDetail}
            className="inline-flex items-center gap-1 text-[10px] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]"
          >
            <ChevronDown
              size={10}
              className={cn("transition-transform", showDetail ? "rotate-0" : "-rotate-90")}
              aria-hidden
            />
            {showDetail ? "Hide" : "Why?"}
          </button>
          {showDetail ? (
            <div className="mt-1.5 space-y-1 rounded-[var(--radius-xs)] bg-[var(--surface-tinted)] px-2 py-1.5 text-[11px] leading-snug">
              {notification.agentProbableCause ? (
                <Detail label="Cause">{notification.agentProbableCause}</Detail>
              ) : null}
              {notification.agentNextAction ? (
                <Detail label="Action" emphasis>
                  {notification.agentNextAction}
                  {notification.agentConfidence != null ? (
                    <span className="ml-1.5 font-mono text-[9px] text-[var(--ink-tertiary)]">
                      ({notification.agentConfidence.toString()}%)
                    </span>
                  ) : null}
                </Detail>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Detail({
  label,
  children,
  emphasis,
}: {
  label: string;
  children: React.ReactNode;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <div>
      <span className="font-mono text-[9px] uppercase tracking-[0.04em] text-[var(--ink-tertiary)]">
        {label}:
      </span>{" "}
      <span className={cn(emphasis ? "text-[var(--ink-primary)]" : "text-[var(--ink-secondary)]")}>
        {children}
      </span>
    </div>
  );
}

function FilterChip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "negative" | "warning" | "info";
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const activeCls =
    tone === "negative"
      ? "pill-negative"
      : tone === "warning"
        ? "pill-warning"
        : tone === "info"
          ? "pill-info"
          : "pill-neutral";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
        active
          ? activeCls
          : "text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
      )}
    >
      {children}
    </button>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes.toString()}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours.toString()}h`;
  const days = Math.floor(hours / 24);
  return `${days.toString()}d`;
}
