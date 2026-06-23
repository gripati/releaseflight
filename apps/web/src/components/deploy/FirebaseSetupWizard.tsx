"use client";
import { useState } from "react";
import { ExternalLink, FileUp } from "lucide-react";
import { Button, Input, Label, Spinner, cn } from "@marquee/ui";
import { GuidePipeline, Instructions, Callout } from "../credentials/guideKit";
import { parseFirebaseFiles } from "./firebaseFiles";
import { api } from "@/lib/apiClient";
import type { AppConnectionDto } from "@marquee/api-contracts";

/**
 * No-code, step-by-step guide for connecting Firebase App Distribution to an
 * app. Self-contained: manages its own state, parses the dropped config files,
 * and POSTs the connection. The numbered instructions are self-explanatory, so
 * the guide carries no screenshots.
 *
 * When `connection` is supplied (editing an already-connected Firebase) the
 * wizard opens straight at the final "Connect" step with the saved app ids
 * pre-filled — it never drags the user back through the whole guide, and it can
 * save metadata changes without re-uploading the service account.
 */
export interface FirebaseSetupWizardProps {
  appId: string;
  connection?: AppConnectionDto | null;
  onDone: () => Promise<void>;
  onBack: () => void;
}

interface GuideStep {
  key: string;
  title: string;
  pill: string;
  open?: { label: string; href: string };
}

/** One Firebase-registered app, as returned by the discover endpoint. */
export interface FirebaseAppOption {
  appId: string;
  displayName?: string;
  bundleId?: string; // iOS
  packageName?: string; // Android
}

type MatchReason = "exact" | "only" | "ambiguous" | "none";

interface DiscoverResult {
  suggestedIosAppId: string | null;
  suggestedAndroidAppId: string | null;
  iosApps: FirebaseAppOption[];
  androidApps: FirebaseAppOption[];
  iosMatch: MatchReason;
  androidMatch: MatchReason;
}

/** Honest, specific status line describing what discovery actually did. */
function buildDiscoverNote(d: DiscoverResult): string {
  const ni = d.iosApps.length;
  const na = d.androidApps.length;
  const counts = `Found ${ni.toString()} iOS · ${na.toString()} Android app${ni + na === 1 ? "" : "s"}`;

  const ambiguous: string[] = [];
  if (d.iosMatch === "ambiguous") ambiguous.push("iOS");
  if (d.androidMatch === "ambiguous") ambiguous.push("Android");
  if (ambiguous.length > 0) {
    return `${counts}. Several ${ambiguous.join(" & ")} apps — pick the right one below.`;
  }
  if (d.suggestedIosAppId ?? d.suggestedAndroidAppId) {
    return `${counts}. Auto-filled the App ID${d.suggestedIosAppId && d.suggestedAndroidAppId ? "s" : ""} below — change it if it's wrong.`;
  }
  if (ni + na === 0) {
    return "No apps are registered in this Firebase project yet — register one, then enter its App ID.";
  }
  return `${counts}, but none match this app's bundle id. Pick one below or register the app in Firebase.`;
}

const STEPS: GuideStep[] = [
  {
    key: "register",
    title: "Register your app in Firebase",
    pill: "Register app",
    open: { label: "Open Firebase Console", href: "https://console.firebase.google.com" },
  },
  {
    key: "config",
    title: "Download the config file",
    pill: "Config file",
  },
  {
    key: "enable",
    title: "Enable App Distribution",
    pill: "App Distribution",
  },
  {
    key: "service-account",
    title: "Generate the service-account key",
    pill: "Service account",
  },
  {
    key: "connect",
    title: "Connect in Release Flight",
    pill: "Connect",
  },
];

export function FirebaseSetupWizard(props: FirebaseSetupWizardProps): JSX.Element {
  const editing = Boolean(props.connection);
  const meta = (props.connection?.metadata ?? {}) as {
    iosAppId?: string | null;
    androidAppId?: string | null;
    projectId?: string | null;
  };
  // Editing a saved connection jumps straight to the Connect step — no need to
  // re-walk the Firebase Console guide every time.
  const [sub, setSub] = useState(editing ? STEPS.length - 1 : 0);
  const step = STEPS[sub]!;
  const isLast = sub === STEPS.length - 1;

  // Final-step form state (pre-filled from the saved connection when editing)
  const [saJson, setSaJson] = useState("");
  const [iosAppId, setIosAppId] = useState(meta.iosAppId ?? "");
  const [androidAppId, setAndroidAppId] = useState(meta.androidAppId ?? "");
  const [projectId, setProjectId] = useState(meta.projectId ?? "");
  const [detected, setDetected] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  const [iosApps, setIosApps] = useState<FirebaseAppOption[]>([]);
  const [androidApps, setAndroidApps] = useState<FirebaseAppOption[]>([]);

  async function ingest(files: FileList | File[]): Promise<void> {
    const r = await parseFirebaseFiles(files);
    if (r.saJson) setSaJson(r.saJson);
    if (r.iosAppId) setIosAppId(r.iosAppId);
    if (r.androidAppId) setAndroidAppId(r.androidAppId);
    if (r.projectId) setProjectId(r.projectId);
    if (r.detected.length > 0) {
      setError(null);
      setDetected((p) => Array.from(new Set([...p, ...r.detected])));
    } else {
      setError("Couldn't read that file — drop service-account.json, GoogleService-Info.plist, or google-services.json.");
    }
    // Got the service account → ask Firebase for the project's App IDs and
    // fill them in automatically (no plist/json needed).
    if (r.saJson) void discover(r.saJson);
  }

  async function discover(serviceAccountJson: string): Promise<void> {
    setDiscovering(true);
    setDiscoverNote(null);
    const res = await api<DiscoverResult>(`/api/v1/apps/${props.appId}/firebase-discover`, {
      method: "POST",
      body: { serviceAccountJson },
    });
    setDiscovering(false);
    if (res.ok) {
      setIosApps(res.data.iosApps);
      setAndroidApps(res.data.androidApps);
      // Only overwrite a field when discovery has a suggestion — keep whatever
      // the user typed or the plist gave us if the project is ambiguous.
      if (res.data.suggestedIosAppId) setIosAppId(res.data.suggestedIosAppId);
      if (res.data.suggestedAndroidAppId) setAndroidAppId(res.data.suggestedAndroidAppId);
      setDiscoverNote(buildDiscoverNote(res.data));
    } else {
      setDiscoverNote(
        `Couldn't list the project's apps (${res.message}). Drop your GoogleService-Info.plist / google-services.json, or enter the App ID manually.`,
      );
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    // Editing without a new service account → metadata-only update (keeps the
    // saved key). Otherwise create/replace the connection with the new key.
    const res =
      editing && !saJson && props.connection
        ? await api(`/api/v1/apps/${props.appId}/connections/${props.connection.id}`, {
            method: "PATCH",
            body: {
              iosAppId: iosAppId || null,
              androidAppId: androidAppId || null,
            },
          })
        : await api(`/api/v1/apps/${props.appId}/connections`, {
            method: "POST",
            body: {
              kind: "FIREBASE",
              serviceAccountJson: saJson,
              iosAppId: iosAppId || undefined,
              androidAppId: androidAppId || undefined,
              testerGroups: [],
            },
          });
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await props.onDone();
  }

  function back(): void {
    if (sub === 0) props.onBack();
    else setSub((s) => s - 1);
  }

  return (
    <section className="space-y-5">
      <GuidePipeline steps={STEPS} current={sub} onJump={setSub} />

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-tertiary)]">
          Step {(sub + 1).toString()} of {STEPS.length.toString()} · {step.pill}
        </p>
        <h3 className="mt-1 font-display text-[18px] leading-tight text-[var(--ink-primary)]">
          {step.title}
        </h3>
      </div>

      <StepBody
        stepKey={step.key}
        state={{ saJson, iosAppId, androidAppId, projectId, detected, dragOver, discovering, discoverNote, iosApps, androidApps, editing }}
        setIosAppId={setIosAppId}
        setAndroidAppId={setAndroidAppId}
        setDragOver={setDragOver}
        ingest={ingest}
      />

      {step.open && (
        <a
          href={step.open.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] border border-[var(--stroke-default)] px-3 py-1.5 font-body text-[12px] text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-tinted)]"
        >
          <ExternalLink size={13} /> {step.open.label}
        </a>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
        >
          {error}
        </p>
      )}

      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={back} disabled={saving}>
          ← Back
        </Button>
        {isLast ? (
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={(!editing && !saJson) || saving}
          >
            {saving ? <Spinner size={12} /> : editing ? "Update connection →" : "Save connection →"}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setSub((s) => s + 1)}>
            Next →
          </Button>
        )}
      </div>
    </section>
  );
}

interface FormState {
  saJson: string;
  iosAppId: string;
  androidAppId: string;
  projectId: string;
  detected: string[];
  dragOver: boolean;
  discovering: boolean;
  discoverNote: string | null;
  iosApps: FirebaseAppOption[];
  androidApps: FirebaseAppOption[];
  editing: boolean;
}

function StepBody({
  stepKey,
  state,
  setIosAppId,
  setAndroidAppId,
  setDragOver,
  ingest,
}: {
  stepKey: string;
  state: FormState;
  setIosAppId: (v: string) => void;
  setAndroidAppId: (v: string) => void;
  setDragOver: (v: boolean) => void;
  ingest: (files: FileList | File[]) => Promise<void>;
}): JSX.Element {
  switch (stepKey) {
    case "register":
      return (
        <>
          <Instructions>
            <li>
              Open the <strong>Firebase Console</strong> and select (or create) your project.
            </li>
            <li>
              On the project overview, click <strong>Add app</strong> and pick the platform — iOS or
              Android.
            </li>
            <li>
              Enter your <strong>bundle ID</strong> (iOS, e.g. <code>com.example.app</code>) or{" "}
              <strong>package name</strong> (Android) and register.
            </li>
          </Instructions>
          <Callout>
            For App Distribution you can <strong>skip</strong> the “Add the SDK” and “Add
            initialisation code” steps — those are only needed if your app calls Firebase at
            runtime.
          </Callout>
        </>
      );
    case "config":
      return (
        <>
          <Instructions>
            <li>
              Click <strong>Download GoogleService-Info.plist</strong> (iOS) or{" "}
              <strong>google-services.json</strong> (Android).
            </li>
            <li>Keep this file — you’ll drop it into Release Flight in the last step.</li>
          </Instructions>
          <Callout>
            This file carries your <strong>App ID</strong> (<code>1:…:ios:…</code>). Release Flight reads it
            automatically — you don’t need to add it to Xcode for App Distribution.
          </Callout>
        </>
      );
    case "enable":
      return (
        <Instructions>
          <li>
            In the Firebase Console’s left menu, open <strong>App Distribution</strong> (under
            Release &amp; Monitor).
          </li>
          <li>
            Click <strong>Get started</strong> to enable it for the project (one-time).
          </li>
          <li>
            Optionally create a <strong>tester group</strong> (e.g. <code>testers</code>) — Release Flight
            can target it later.
          </li>
        </Instructions>
      );
    case "service-account":
      return (
        <>
          <Instructions>
            <li>
              Go to <strong>Project settings → Service accounts</strong>.
            </li>
            <li>
              Click <strong>Generate new private key</strong> → confirm. A <code>.json</code>{" "}
              downloads. (The Node.js/Java/… selector only changes the sample code — ignore it.)
            </li>
          </Instructions>
          <Callout tone="warning">
            Keep this file secret. If App Distribution later fails with a permission error, grant the
            service account the <strong>Firebase App Distribution Admin</strong> role in Google Cloud
            IAM.
          </Callout>
        </>
      );
    case "connect":
      return (
        <ConnectStep
          state={state}
          setIosAppId={setIosAppId}
          setAndroidAppId={setAndroidAppId}
          setDragOver={setDragOver}
          ingest={ingest}
        />
      );
    default:
      return <></>;
  }
}

function ConnectStep({
  state,
  setIosAppId,
  setAndroidAppId,
  setDragOver,
  ingest,
}: {
  state: FormState;
  setIosAppId: (v: string) => void;
  setAndroidAppId: (v: string) => void;
  setDragOver: (v: boolean) => void;
  ingest: (files: FileList | File[]) => Promise<void>;
}): JSX.Element {
  return (
    <div className="space-y-4">
      {state.editing && (
        <div className="rounded-md border border-[var(--status-success)] bg-[var(--surface-sunken)] px-3 py-2 text-[12px] text-[var(--ink-secondary)]">
          <span className="font-medium text-[var(--status-success)]">✓ Already connected</span>
          {state.projectId ? ` to Firebase project ${state.projectId}` : ""}. Adjust the app ids below
          and click <strong>Update connection</strong> — your service account stays saved. Only drop a
          new <strong>service-account.json</strong> if you want to replace the key.
        </div>
      )}
      <Instructions>
        <li>
          Drop the <strong>service-account.json</strong> and your{" "}
          <strong>GoogleService-Info.plist</strong> / <strong>google-services.json</strong> here —
          the project and app ids fill in automatically.
        </li>
        <li>
          Click <strong>{state.editing ? "Update connection" : "Save connection"}</strong>.
        </li>
      </Instructions>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void ingest(e.dataTransfer.files);
        }}
        onClick={() => document.getElementById("fb-wizard-file")?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed p-5 text-center transition-colors",
          state.dragOver
            ? "border-[var(--signal)] bg-[var(--surface-tinted)]"
            : "border-[var(--stroke-default)] hover:bg-[var(--surface-tinted)]",
        )}
      >
        <FileUp size={18} className="text-[var(--ink-tertiary)]" />
        <span className="text-[13px] text-[var(--ink-primary)]">Drop your Firebase files</span>
        <span className="text-[11px] text-[var(--ink-tertiary)]">
          service-account.json · GoogleService-Info.plist · google-services.json
        </span>
        <input
          id="fb-wizard-file"
          type="file"
          multiple
          accept=".json,.plist"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void ingest(e.target.files);
          }}
        />
      </div>

      {state.detected.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md bg-[var(--surface-sunken)] p-2">
          {state.detected.map((d, i) => (
            <span key={i} className="text-[11px] text-[var(--status-success)]">
              ✓ Detected {d}
            </span>
          ))}
          {state.projectId && (
            <span className="text-[11px] text-[var(--ink-tertiary)]">
              Firebase project: {state.projectId}
            </span>
          )}
        </div>
      )}

      {(state.discovering || state.discoverNote) && (
        <p className="flex items-center gap-1.5 text-[11px] text-[var(--ink-secondary)]">
          {state.discovering && <Spinner size={11} />}
          {state.discovering ? "Looking up your Firebase apps…" : state.discoverNote}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="fb-ios">iOS app id</Label>
          <Input
            id="fb-ios"
            placeholder="1:…:ios:…"
            value={state.iosAppId}
            onChange={(e) => setIosAppId(e.target.value)}
            className="mt-1.5 font-mono text-[12px]"
          />
          <AppPicker kind="ios" apps={state.iosApps} value={state.iosAppId} onPick={setIosAppId} />
        </div>
        <div>
          <Label htmlFor="fb-android">Android app id</Label>
          <Input
            id="fb-android"
            placeholder="1:…:android:…"
            value={state.androidAppId}
            onChange={(e) => setAndroidAppId(e.target.value)}
            className="mt-1.5 font-mono text-[12px]"
          />
          <AppPicker
            kind="android"
            apps={state.androidApps}
            value={state.androidAppId}
            onPick={setAndroidAppId}
          />
        </div>
      </div>

      <p className="font-body text-[11px] text-[var(--ink-tertiary)]">
        Stored encrypted in your secret manager. Only metadata appears in the database.
      </p>
    </div>
  );
}

/**
 * Clickable list of the Firebase apps discovered for the project. Lets the user
 * pick the right App ID when auto-fill couldn't (several apps, none matching) or
 * override a wrong guess. Renders nothing until discovery returns apps.
 */
function AppPicker({
  kind,
  apps,
  value,
  onPick,
}: {
  kind: "ios" | "android";
  apps: FirebaseAppOption[];
  value: string;
  onPick: (appId: string) => void;
}): JSX.Element | null {
  if (apps.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {apps.map((a) => {
        const label = (kind === "ios" ? a.bundleId : a.packageName) ?? a.displayName ?? a.appId;
        const selected = a.appId === value;
        return (
          <button
            key={a.appId}
            type="button"
            onClick={() => onPick(a.appId)}
            title={a.appId}
            aria-pressed={selected}
            className={cn(
              "max-w-full truncate rounded-[var(--radius-xs)] border px-2 py-1 font-mono text-[10px] transition-colors",
              selected
                ? "border-[var(--signal)] bg-[var(--surface-tinted)] text-[var(--ink-primary)]"
                : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
