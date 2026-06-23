"use client";

/**
 * Deploy tab — connect the required services (no-code wizard), launch a
 * build+deploy to Firebase App Distribution, and watch live build logs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Users, RefreshCw, Check } from "lucide-react";
import {
  Button,
  Card,
  Input,
  Textarea,
  Label,
  StateDot,
  Stamp,
  Spinner,
  Divider,
  cn,
} from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { isTesterEmail } from "@marquee/api-contracts";
import type {
  AppConnectionDto,
  BuildConfigDto,
  BuildSummaryDto,
  FirebaseGroupsResponse,
  FirebaseTesterGroupDto,
} from "@marquee/api-contracts";
import { FirebaseSetupWizard } from "./FirebaseSetupWizard";
import { BuildAnalysis } from "./BuildAnalysis";

type Kind = "GIT" | "FIREBASE" | "ANDROID_KEYSTORE";
type Target = "FIREBASE_APP_DISTRIBUTION" | "APPLE_TESTFLIGHT" | "APPLE_APP_STORE" | "GOOGLE_PLAY";

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

// What each target does. App Store = upload to App Store Connect: the build is
// then available in TestFlight for beta testers AND ready to submit for review —
// one target covers both, so there's no separate TestFlight option.
const TARGET_DESC: Record<Target, string> = {
  FIREBASE_APP_DISTRIBUTION:
    "Quick beta straight to your testers — no Apple review. Signs with your Mac's local certificate, so it works without an App Store Connect key.",
  APPLE_TESTFLIGHT:
    "Uploads to App Store Connect — available in TestFlight for beta testers and ready to submit for App Store review. Uses your connected App Store Connect key.",
  APPLE_APP_STORE:
    "Uploads to App Store Connect — available in TestFlight for beta testers and ready to submit for App Store review. Uses your connected App Store Connect key.",
  GOOGLE_PLAY:
    "Uploads an AAB to a Google Play track. Needs a Google Play service account + an Android keystore.",
};

const TARGETS_FOR: Record<"IOS" | "ANDROID", { value: Target; label: string }[]> = {
  IOS: [
    { value: "FIREBASE_APP_DISTRIBUTION", label: "Firebase App Distribution" },
    { value: "APPLE_APP_STORE", label: "App Store" },
  ],
  ANDROID: [
    { value: "FIREBASE_APP_DISTRIBUTION", label: "Firebase App Distribution" },
    { value: "GOOGLE_PLAY", label: "Google Play" },
  ],
};

export function DeployPanel({
  appId,
  platform,
  appName,
}: {
  appId: string;
  platform: "IOS" | "ANDROID";
  appName: string;
}): JSX.Element {
  const [connections, setConnections] = useState<AppConnectionDto[]>([]);
  const [buildConfig, setBuildConfig] = useState<BuildConfigDto | null>(null);
  const [builds, setBuilds] = useState<BuildSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>("FIREBASE_APP_DISTRIBUTION");
  const [tenantCreds, setTenantCreds] = useState<{ kind: string }[]>([]);
  // Firebase tester-group picker (release-to-group, like Unity GamePublisher)
  const [fbGroups, setFbGroups] = useState<FirebaseTesterGroupDto[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [groupsNote, setGroupsNote] = useState<string | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [testerEmails, setTesterEmails] = useState("");
  // Versioning inputs — pre-filled from the stored config, re-synced after each
  // deploy so the build number shows the freshly auto-incremented next value.
  const [versionInput, setVersionInput] = useState("");
  const [buildInput, setBuildInput] = useState("");

  const reloadConnections = useCallback(async () => {
    const res = await api<{ connections: AppConnectionDto[] }>(`/api/v1/apps/${appId}/connections`);
    if (res.ok) setConnections(res.data.connections);
  }, [appId]);

  const reloadTenantCreds = useCallback(async () => {
    const res = await api<{ credentials: { kind: string }[] }>(`/api/v1/credentials`);
    if (res.ok) setTenantCreds(res.data.credentials);
  }, []);

  const reloadBuildConfig = useCallback(async () => {
    const res = await api<{ config: BuildConfigDto }>(`/api/v1/apps/${appId}/build-config`);
    if (res.ok) setBuildConfig(res.data.config);
  }, [appId]);

  const reloadBuilds = useCallback(async () => {
    const res = await api<{ builds: BuildSummaryDto[] }>(`/api/v1/apps/${appId}/builds-history`);
    if (res.ok) setBuilds(res.data.builds);
  }, [appId]);

  const reloadFirebaseGroups = useCallback(async () => {
    setGroupsLoading(true);
    setGroupsNote(null);
    const res = await api<FirebaseGroupsResponse>(`/api/v1/apps/${appId}/firebase-groups`);
    setGroupsLoading(false);
    if (res.ok) {
      setFbGroups(res.data.groups);
      // Pre-select the connection's saved groups, but only those that still
      // exist in Firebase (so a chip can't be "selected yet invisible"). If the
      // list couldn't be fetched, keep the saved selection as a best effort.
      const aliases = new Set(res.data.groups.map((g) => g.alias));
      setSelectedGroups(
        res.data.groups.length > 0
          ? res.data.selected.filter((a) => aliases.has(a))
          : res.data.selected,
      );
      setGroupsNote(res.data.note ?? null);
    } else {
      // Couldn't list groups (transient) — KEEP the existing selection rather
      // than silently downgrading the release to "upload to nobody". Warn so the
      // user knows the list couldn't be confirmed.
      setFbGroups([]);
      setGroupsNote(
        `Couldn't list tester groups (${res.message}). Your saved groups will still be used.`,
      );
    }
  }, [appId]);

  useEffect(() => {
    void (async () => {
      await Promise.all([
        reloadConnections(),
        reloadBuildConfig(),
        reloadBuilds(),
        reloadTenantCreds(),
      ]);
      setLoading(false);
    })();
  }, [reloadConnections, reloadBuildConfig, reloadBuilds, reloadTenantCreds]);

  // Poll builds while any is in flight; also refresh the build config so the
  // build-number field reflects the runner's assignment on the first auto deploy.
  const activeBuild = builds.find((b) => !TERMINAL.has(b.status));
  useEffect(() => {
    if (!activeBuild) return;
    const t = setInterval(() => {
      void reloadBuilds();
      void reloadBuildConfig();
    }, 4000);
    return () => clearInterval(t);
  }, [activeBuild, reloadBuilds, reloadBuildConfig]);

  // Pull Firebase tester groups once the target is Firebase and it's connected.
  const firebaseConnected = connections.some((c) => c.kind === "FIREBASE");
  useEffect(() => {
    if (target === "FIREBASE_APP_DISTRIBUTION" && firebaseConnected) {
      void reloadFirebaseGroups();
    }
  }, [target, firebaseConnected, reloadFirebaseGroups]);

  // Sync version + build-number inputs from the stored config, but ONLY when the
  // stored value actually changes (initial load, or the post-deploy +1 bump) AND
  // the user isn't editing that field — so the 4s poll never clobbers typing.
  const lastSyncedVersion = useRef<string | null>(null);
  const lastSyncedBuild = useRef<number | null>(null);
  const editingVersion = useRef(false);
  const editingBuild = useRef(false);
  useEffect(() => {
    if (!buildConfig) return;
    const v = buildConfig.versionName ?? null;
    const b = buildConfig.nextBuildNumber ?? null;
    if (lastSyncedVersion.current !== v) {
      lastSyncedVersion.current = v;
      if (!editingVersion.current) setVersionInput(v ?? "");
    }
    if (lastSyncedBuild.current !== b) {
      lastSyncedBuild.current = b;
      if (!editingBuild.current) setBuildInput(b != null ? b.toString() : "");
    }
  }, [buildConfig]);

  async function resetVersioningToAuto(): Promise<void> {
    await api(`/api/v1/apps/${appId}/build-config`, {
      method: "PUT",
      body: { nextBuildNumber: null, versionName: null },
    });
    lastSyncedVersion.current = null;
    lastSyncedBuild.current = null;
    setVersionInput("");
    setBuildInput("");
    await reloadBuildConfig();
  }

  const byKind = (k: Kind): AppConnectionDto | null =>
    connections.find((c) => c.kind === k) ?? null;
  const sourceConnected = Boolean(buildConfig?.localPath) || Boolean(byKind("GIT"));
  const serviceKinds: Kind[] =
    platform === "ANDROID" ? ["ANDROID_KEYSTORE", "FIREBASE"] : ["FIREBASE"];
  const allConnected = sourceConnected && serviceKinds.every((k) => byKind(k));
  const hasApple = tenantCreds.some((c) => c.kind === "APPLE");
  const hasGoogle = tenantCreds.some((c) => c.kind === "GOOGLE");

  // What's still missing for the selected target (drives the Deploy gate).
  function targetReady(t: Target): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!sourceConnected) missing.push("Build source");
    if (t === "FIREBASE_APP_DISTRIBUTION") {
      if (!byKind("FIREBASE")) missing.push("Firebase");
      if (platform === "ANDROID" && !byKind("ANDROID_KEYSTORE")) missing.push("Android keystore");
    } else if (t === "GOOGLE_PLAY") {
      if (!hasGoogle) missing.push("Google Play service account (Credentials)");
      if (!byKind("ANDROID_KEYSTORE")) missing.push("Android keystore");
    } else {
      if (!hasApple) missing.push("App Store Connect key (Credentials)");
    }
    return { ok: missing.length === 0, missing };
  }
  const ready = targetReady(target);

  async function launch(): Promise<void> {
    setDeployError(null);
    setDeploying(true);
    const res = await api<{ buildId: string; jobId: string }>(`/api/v1/apps/${appId}/deploy`, {
      method: "POST",
      body: {
        platform,
        target,
        releaseNotes: releaseNotes || undefined,
        ...(versionInput.trim() ? { versionName: versionInput.trim() } : {}),
        ...(/^\d+$/.test(buildInput.trim()) ? { buildNumber: Number(buildInput.trim()) } : {}),
        ...(target === "FIREBASE_APP_DISTRIBUTION"
          ? { firebaseGroups: selectedGroups, firebaseTesters: parseEmails(testerEmails) }
          : {}),
      },
    });
    setDeploying(false);
    if (res.ok) {
      setReleaseNotes("");
      // Reload the config so the build-number field instantly shows the bumped
      // next value, and refresh the build list.
      await Promise.all([reloadBuilds(), reloadBuildConfig()]);
    } else {
      setDeployError(res.message);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-[13px] text-[var(--ink-secondary)]">
        <Spinner size={14} /> Loading deploy configuration…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="font-display text-[18px] text-[var(--ink-primary)]">Deploy</h2>
        <p className="mt-0.5 text-[13px] text-[var(--ink-secondary)]">
          Connect your services once, then ship {appName} straight to Firebase App Distribution.
        </p>
      </header>

      {/* ── Connections ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionTitle
          title="Connections"
          hint={
            allConnected
              ? "All set — ready to deploy."
              : "Connect everything below to enable deploys."
          }
          ok={allConnected}
        />
        <BuildSourceCard
          appId={appId}
          gitConn={byKind("GIT")}
          buildConfig={buildConfig}
          onConnectionsChanged={reloadConnections}
          onConfigChanged={reloadBuildConfig}
        />
        {serviceKinds.map((k) => (
          <ConnectionCard
            key={k}
            appId={appId}
            kind={k}
            connection={byKind(k)}
            onChanged={reloadConnections}
          />
        ))}
      </section>

      {/* ── Launch ──────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionTitle title="New deploy" />
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Stamp>{platform}</Stamp>
            <span className="text-[var(--ink-secondary)]">→</span>
            <div className="inline-flex flex-wrap gap-1.5">
              {TARGETS_FOR[platform].map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTarget(t.value)}
                  className={cn(
                    "rounded-[var(--radius-pill)] border px-2.5 py-1 text-[12px] transition-colors",
                    target === t.value
                      ? "border-transparent bg-[var(--ink-primary)] text-[var(--surface-elevated)]"
                      : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <p className="-mt-1.5 text-[11px] leading-[1.5] text-[var(--ink-tertiary)]">
            {TARGET_DESC[target]}
          </p>
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="version-input">Version</Label>
                <Input
                  id="version-input"
                  placeholder="1.0.0"
                  maxLength={64}
                  value={versionInput}
                  onFocus={() => (editingVersion.current = true)}
                  onBlur={() => (editingVersion.current = false)}
                  onChange={(e) => setVersionInput(e.target.value)}
                  className="font-mono text-[12px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="build-input">Build number</Label>
                <Input
                  id="build-input"
                  inputMode="numeric"
                  placeholder="auto (from project)"
                  value={buildInput}
                  onFocus={() => (editingBuild.current = true)}
                  onBlur={() => (editingBuild.current = false)}
                  onChange={(e) => setBuildInput(e.target.value.replace(/[^\d]/g, ""))}
                  className="font-mono text-[12px]"
                />
              </div>
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--ink-tertiary)]">
              <span>
                Stamped into the build. The build number auto-increments after each deploy —
                whatever you set is used next, then bumped by 1.
              </span>
              {(buildConfig?.nextBuildNumber != null || buildConfig?.versionName != null) && (
                <button
                  onClick={() => void resetVersioningToAuto()}
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--ink-primary)]"
                >
                  Reset to auto
                </button>
              )}
            </p>
          </div>

          {target === "FIREBASE_APP_DISTRIBUTION" && (
            <FirebaseAudience
              groups={fbGroups}
              selected={selectedGroups}
              loading={groupsLoading}
              note={groupsNote}
              testerEmails={testerEmails}
              onToggle={(alias) =>
                setSelectedGroups((s) =>
                  s.includes(alias) ? s.filter((a) => a !== alias) : [...s, alias],
                )
              }
              onRefresh={() => void reloadFirebaseGroups()}
              setTesterEmails={setTesterEmails}
            />
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="release-notes">Release notes (optional)</Label>
            <Textarea
              id="release-notes"
              rows={3}
              placeholder="What testers should know about this build…"
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
            />
          </div>
          {deployError && <p className="text-[12px] text-[var(--status-danger)]">{deployError}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void launch()} disabled={!ready.ok || deploying}>
              {deploying ? <Spinner size={12} /> : "Deploy"}
            </Button>
            {!ready.ok && (
              <span className="text-[12px] text-[var(--ink-tertiary)]">
                Connect: {ready.missing.join(", ")}.
              </span>
            )}
          </div>
        </Card>
      </section>

      {/* ── Builds ──────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionTitle title="Builds" />
        {builds.length === 0 ? (
          <Card className="p-4 text-[13px] text-[var(--ink-secondary)]">No builds yet.</Card>
        ) : (
          <div className="flex flex-col gap-2">
            {builds.map((b) => (
              <BuildRow key={b.id} appId={appId} build={b} onChanged={reloadBuilds} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionTitle({
  title,
  hint,
  ok,
}: {
  title: string;
  hint?: string;
  ok?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="font-display text-[14px] text-[var(--ink-primary)]">{title}</h3>
      {hint && (
        <span
          className={cn(
            "text-[12px]",
            ok ? "text-[var(--status-success)]" : "text-[var(--ink-tertiary)]",
          )}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

// ── Firebase audience picker (release to tester groups / emails) ────────
/** Tokens that are valid tester emails — uses the SAME validator as the deploy
 *  contract so a typo can never pass here and 400 the whole launch. */
function parseEmails(raw: string): string[] {
  return emailTokens(raw).filter(isTesterEmail);
}
function emailTokens(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function FirebaseAudience({
  groups,
  selected,
  loading,
  note,
  testerEmails,
  onToggle,
  onRefresh,
  setTesterEmails,
}: {
  groups: FirebaseTesterGroupDto[];
  selected: string[];
  loading: boolean;
  note: string | null;
  testerEmails: string;
  onToggle: (alias: string) => void;
  onRefresh: () => void;
  setTesterEmails: (v: string) => void;
}): JSX.Element {
  const emailCount = parseEmails(testerEmails).length;
  const invalidCount = emailTokens(testerEmails).length - emailCount;
  const total = selected.length + emailCount;
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-sunken)] p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-primary)]">
          <Users size={13} className="text-[var(--ink-tertiary)]" /> Distribute to
        </span>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1 text-[11px] text-[var(--ink-tertiary)] transition-colors hover:text-[var(--ink-primary)]"
        >
          {loading ? <Spinner size={11} /> : <RefreshCw size={11} />} Refresh
        </button>
      </div>

      {groups.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {groups.map((g) => {
            const on = selected.includes(g.alias);
            return (
              <button
                key={g.alias}
                onClick={() => onToggle(g.alias)}
                className={cn(
                  "flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 py-1 text-[12px] transition-colors",
                  on
                    ? "border-transparent bg-[var(--ink-primary)] text-[var(--surface-elevated)]"
                    : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
                )}
                title={`Group alias: ${g.alias}`}
              >
                {on && <Check size={12} />}
                {g.displayName}
                {g.testerCount != null && (
                  <span
                    className={cn("text-[10px]", on ? "opacity-80" : "text-[var(--ink-tertiary)]")}
                  >
                    {g.testerCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-[var(--ink-tertiary)]">
          {loading
            ? "Loading tester groups…"
            : (note ??
              "No tester groups found. Create one in the Firebase Console (App Distribution → Testers & Groups), or add tester emails below.")}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="fb-testers">Additional testers (emails, optional)</Label>
        <Input
          id="fb-testers"
          placeholder="alice@example.com, bob@example.com"
          value={testerEmails}
          onChange={(e) => setTesterEmails(e.target.value)}
          className="font-mono text-[12px]"
        />
        {invalidCount > 0 && (
          <span className="text-[11px] text-[var(--status-warning)]">
            {invalidCount} address{invalidCount === 1 ? "" : "es"} look invalid and will be ignored.
          </span>
        )}
      </div>

      <p className="text-[11px] text-[var(--ink-tertiary)]">
        {total > 0
          ? `This build will be released to ${selected.length > 0 ? `${selected.length.toString()} group${selected.length === 1 ? "" : "s"}` : ""}${selected.length > 0 && emailCount > 0 ? " + " : ""}${emailCount > 0 ? `${emailCount.toString()} tester${emailCount === 1 ? "" : "s"}` : ""} for testing.`
          : "No audience selected — the build uploads to Firebase but isn't released to testers (you can assign it later in the console)."}
      </p>
    </div>
  );
}

// ── Build source (local folder vs git) ─────────────────────────────────
function BuildSourceCard({
  appId,
  gitConn,
  buildConfig,
  onConnectionsChanged,
  onConfigChanged,
}: {
  appId: string;
  gitConn: AppConnectionDto | null;
  buildConfig: BuildConfigDto | null;
  onConnectionsChanged: () => Promise<void>;
  onConfigChanged: () => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<"LOCAL" | "GIT">(
    buildConfig?.localPath ? "LOCAL" : gitConn ? "GIT" : "LOCAL",
  );
  const [localPath, setLocalPath] = useState(buildConfig?.localPath ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const connected =
    (mode === "LOCAL" && Boolean(buildConfig?.localPath)) || (mode === "GIT" && Boolean(gitConn));

  async function saveLocal(): Promise<void> {
    setSaving(true);
    setMsg(null);
    // No-code: clear any legacy subfolder/scheme so the runner auto-detects the
    // project location and Xcode scheme. The user only provides the folder.
    const res = await api(`/api/v1/apps/${appId}/build-config`, {
      method: "PUT",
      body: { localPath: localPath.trim() || null, workdirSubpath: null, iosScheme: null },
    });
    setSaving(false);
    setMsg(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.message });
    if (res.ok) await onConfigChanged();
  }

  async function clearLocal(): Promise<void> {
    await api(`/api/v1/apps/${appId}/build-config`, {
      method: "PUT",
      body: { localPath: null, workdirSubpath: null, iosScheme: null },
    });
    setLocalPath("");
    await onConfigChanged();
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <StateDot state={connected ? "synced" : "empty"} />
          <span className="font-body text-[14px] text-[var(--ink-primary)]">Build source</span>
          {connected && (
            <span className="text-[12px] text-[var(--ink-tertiary)]">
              {mode === "LOCAL" ? buildConfig?.localPath : String(gitConn?.metadata?.repoUrl ?? "")}
            </span>
          )}
        </div>
        <div className="inline-flex rounded-[var(--radius-pill)] border border-[var(--stroke-default)] p-0.5">
          {(["LOCAL", "GIT"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-[var(--radius-pill)] px-2.5 py-1 text-[12px] transition-colors",
                mode === m
                  ? "bg-[var(--ink-primary)] text-[var(--surface-elevated)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {m === "LOCAL" ? "Local folder" : "Git repository"}
            </button>
          ))}
        </div>
      </div>

      {mode === "LOCAL" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="local-path">Project folder on this Mac</Label>
          <Input
            id="local-path"
            placeholder="/Users/you/Projects/my-app"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
          />
          {msg && (
            <p
              className={cn(
                "text-[12px]",
                msg.ok ? "text-[var(--status-success)]" : "text-[var(--status-danger)]",
              )}
            >
              {msg.text}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void saveLocal()} disabled={saving}>
              {saving ? <Spinner size={12} /> : "Use this folder"}
            </Button>
            {buildConfig?.localPath && (
              <Button size="sm" variant="ghost" onClick={() => void clearLocal()}>
                Clear
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <Divider />
          <ConnectionCard
            appId={appId}
            kind="GIT"
            connection={gitConn}
            onChanged={onConnectionsChanged}
          />
        </>
      )}
    </Card>
  );
}

// ── Connection card ─────────────────────────────────────────────────────
const KIND_LABEL: Record<Kind, string> = {
  GIT: "Git repository",
  FIREBASE: "Firebase",
  ANDROID_KEYSTORE: "Android keystore",
};

function ConnectionCard({
  appId,
  kind,
  connection,
  onChanged,
}: {
  appId: string;
  kind: Kind;
  connection: AppConnectionDto | null;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const state: "synced" | "error" | "empty" = !connection
    ? "empty"
    : connection.status === "ERROR"
      ? "error"
      : "synced";

  async function test(): Promise<void> {
    if (!connection) return;
    setTesting(true);
    setTestMsg(null);
    const res = await api<{ ok: boolean; message: string }>(
      `/api/v1/apps/${appId}/connections/${connection.id}/test`,
      { method: "POST" },
    );
    setTesting(false);
    setTestMsg(res.ok ? res.data : { ok: false, message: res.message });
    await onChanged();
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <StateDot state={state} />
          <span className="font-body text-[14px] text-[var(--ink-primary)]">
            {KIND_LABEL[kind]}
          </span>
          {connection && <ConnectionSummary kind={kind} metadata={connection.metadata} />}
        </div>
        <div className="flex items-center gap-2">
          {connection && (
            <Button variant="secondary" size="sm" onClick={() => void test()} disabled={testing}>
              {testing ? <Spinner size={12} /> : "Test"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
            {connection ? "Edit" : "Connect"}
          </Button>
        </div>
      </div>

      {connection?.lastTestMessage && !testMsg && (
        <p
          className={cn(
            "text-[12px]",
            connection.lastTestSucceeded === false
              ? "text-[var(--status-danger)]"
              : "text-[var(--ink-secondary)]",
          )}
        >
          {connection.lastTestMessage}
        </p>
      )}
      {testMsg && (
        <p
          className={cn(
            "text-[12px]",
            testMsg.ok ? "text-[var(--status-success)]" : "text-[var(--status-danger)]",
          )}
        >
          {testMsg.message}
        </p>
      )}

      {open && (
        <>
          <Divider />
          {kind === "FIREBASE" ? (
            <FirebaseSetupWizard
              appId={appId}
              connection={connection}
              onDone={async () => {
                setOpen(false);
                await onChanged();
              }}
              onBack={() => setOpen(false)}
            />
          ) : (
            <ConnectionForm
              appId={appId}
              kind={kind}
              onDone={async () => {
                setOpen(false);
                await onChanged();
              }}
            />
          )}
        </>
      )}
    </Card>
  );
}

function ConnectionSummary({
  kind,
  metadata,
}: {
  kind: Kind;
  metadata: Record<string, unknown> | null;
}): JSX.Element | null {
  if (!metadata) return null;
  if (kind === "GIT") {
    return (
      <span className="text-[12px] text-[var(--ink-tertiary)]">
        {String(metadata.repoUrl ?? "")} · {String(metadata.branch ?? "main")}
      </span>
    );
  }
  if (kind === "FIREBASE") {
    return (
      <span className="text-[12px] text-[var(--ink-tertiary)]">
        {String(metadata.projectId ?? metadata.androidAppId ?? "")}
      </span>
    );
  }
  return (
    <span className="text-[12px] text-[var(--ink-tertiary)]">
      alias {String(metadata.keyAlias ?? "")}
    </span>
  );
}

// ── Per-kind connect forms ──────────────────────────────────────────────
function ConnectionForm({
  appId,
  kind,
  onDone,
}: {
  appId: string;
  kind: Kind;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  // GIT
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  // KEYSTORE
  const fileRef = useRef<HTMLInputElement>(null);
  const [storePassword, setStorePassword] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [keyAlias, setKeyAlias] = useState("");

  async function submit(): Promise<void> {
    setSaving(true);
    setError(null);
    let body: Record<string, unknown>;
    if (kind === "GIT") {
      body = { kind, repoUrl, branch };
    } else {
      const file = fileRef.current?.files?.[0];
      if (!file) {
        setSaving(false);
        setError("Choose a keystore file.");
        return;
      }
      body = {
        kind,
        keystoreBase64: await fileToBase64(file),
        storePassword,
        keyPassword,
        keyAlias,
      };
    }
    const res = await api<{ publicKey?: string }>(`/api/v1/apps/${appId}/connections`, {
      method: "POST",
      body,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (kind === "GIT" && res.data.publicKey) {
      setPublicKey(res.data.publicKey);
      return; // keep open so the user can copy the deploy key
    }
    await onDone();
  }

  if (publicKey) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12px] text-[var(--ink-secondary)]">
          Add this <strong>read-only deploy key</strong> to your repo (GitHub → Settings → Deploy
          keys → Add deploy key), then click Done and Test.
        </p>
        <code className="block max-h-28 overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-[11px] break-all">
          {publicKey}
        </code>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(publicKey)}
          >
            Copy key
          </Button>
          <Button size="sm" onClick={() => void onDone()}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {kind === "GIT" && (
        <>
          <Field label="Repository URL">
            <Input
              placeholder="git@github.com:org/repo.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </Field>
          <Field label="Branch">
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </Field>
          <Hint>We generate a read-only deploy key for you on save — no terminal needed.</Hint>
        </>
      )}

      {kind === "ANDROID_KEYSTORE" && (
        <>
          <Field label="Keystore file (.jks / .keystore)">
            <input
              ref={fileRef}
              type="file"
              accept=".jks,.keystore"
              className="text-[12px] text-[var(--ink-secondary)]"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key alias">
              <Input value={keyAlias} onChange={(e) => setKeyAlias(e.target.value)} />
            </Field>
            <Field label="Store password">
              <Input
                type="password"
                value={storePassword}
                onChange={(e) => setStorePassword(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Key password">
            <Input
              type="password"
              value={keyPassword}
              onChange={(e) => setKeyPassword(e.target.value)}
            />
          </Field>
        </>
      )}

      {error && <p className="text-[12px] text-[var(--status-danger)]">{error}</p>}
      <div>
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? <Spinner size={12} /> : "Save connection"}
        </Button>
      </div>
    </div>
  );
}

// ── Build row + live log ────────────────────────────────────────────────
const STATUS_TONE: Record<string, string> = {
  DONE: "var(--status-success)",
  FAILED: "var(--status-danger)",
  CANCELLED: "var(--status-warning)",
};

function BuildRow({
  appId,
  build,
  onChanged,
}: {
  appId: string;
  build: BuildSummaryDto;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(!TERMINAL.has(build.status));
  const live = !TERMINAL.has(build.status);

  function download(): void {
    // The artifact route streams the bytes through the same-origin Next server
    // (it does NOT return a JSON `{ url }` — a raw S3/MinIO presigned URL would
    // be unreachable on self-host). A plain navigation carries the session
    // cookie and triggers a download via the route's Content-Disposition header.
    window.open(`/api/v1/apps/${appId}/builds/${build.id}/artifact`, "_blank");
  }

  async function cancel(): Promise<void> {
    if (!build.jobId) return;
    await api(`/api/v1/jobs/${build.jobId}/cancel`, { method: "POST" });
    await onChanged();
  }

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <button
          className="flex items-center gap-2.5 text-left"
          onClick={() => setExpanded((e) => !e)}
        >
          <StateDot
            state={
              live
                ? "syncing"
                : build.status === "DONE"
                  ? "synced"
                  : build.status === "FAILED"
                    ? "error"
                    : "empty"
            }
          />
          <span className="font-body text-[13px] text-[var(--ink-primary)]">
            {build.platform} · {build.target.replace(/_/g, " ").toLowerCase()}
          </span>
          {build.frameworkDetected && (
            <span className="text-[11px] text-[var(--ink-tertiary)]">
              {build.frameworkDetected}
            </span>
          )}
          {(build.versionString || build.buildNumber) && (
            <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-secondary)]">
              {build.versionString ? `v${build.versionString} ` : ""}#{build.buildNumber ?? "—"}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-medium"
            style={{ color: STATUS_TONE[build.status] ?? "var(--ink-secondary)" }}
          >
            {build.status}
          </span>
          {typeof build.deployResult?.consoleUrl === "string" && (
            <a
              href={build.deployResult.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[var(--radius-xs)] border border-[var(--stroke-default)] px-2 py-1 text-[11px] text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-tinted)]"
            >
              Open in App Store Connect →
            </a>
          )}
          {build.artifactAvailable && (
            <Button size="sm" variant="secondary" onClick={() => download()}>
              Download
            </Button>
          )}
          {live && build.jobId && (
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {build.errorSummary && (
        <p className="text-[11px] text-[var(--status-danger)]">{build.errorSummary}</p>
      )}

      {build.status === "FAILED" && <BuildAnalysis appId={appId} buildId={build.id} />}

      {expanded && build.jobId && (
        <LiveLog jobId={build.jobId} live={live} onTerminal={onChanged} />
      )}
    </Card>
  );
}

function LiveLog({
  jobId,
  live,
  onTerminal,
}: {
  jobId: string;
  live: boolean;
  onTerminal: () => Promise<void>;
}): JSX.Element {
  const [lines, setLines] = useState<{ text: string; level: string }[]>([]);
  const [step, setStep] = useState<string>("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/v1/jobs/${jobId}/stream`);
    es.addEventListener("progress", (ev) => {
      const data = JSON.parse(ev.data) as {
        step?: string;
        detail?: string;
        level?: string;
      };
      if (data.step) setStep(data.step);
      if (data.detail) {
        setLines((prev) => [
          ...prev.slice(-400),
          { text: data.detail!, level: data.level ?? "info" },
        ]);
      }
      if (data.step === "completed" || data.step === "failed") {
        es.close();
        void onTerminal();
      }
    });
    es.addEventListener("error", () => es.close());
    return () => es.close();
  }, [jobId, live, onTerminal]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [lines]);

  if (!live && lines.length === 0) {
    return <p className="text-[11px] text-[var(--ink-tertiary)]">Build finished. Logs archived.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {step && <span className="text-[11px] text-[var(--ink-secondary)]">{step}</span>}
      <div
        ref={boxRef}
        className="max-h-56 overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-[11px] leading-[1.5]"
      >
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              color:
                l.level === "error"
                  ? "var(--status-danger)"
                  : l.level === "warn"
                    ? "var(--status-warning)"
                    : "var(--ink-secondary)",
            }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tiny presentational helpers ─────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="text-[11px] text-[var(--ink-tertiary)]">{children}</p>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
