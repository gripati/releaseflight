"use client";
import { useState } from "react";
import { ExternalLink, FileUp, ClipboardPaste } from "lucide-react";
import { Button, Input, Label, Spinner, cn } from "@marquee/ui";
import { GuidePipeline, Instructions, Callout } from "./guideKit";

/**
 * No-code, step-by-step guide for obtaining a Google Play service-account JSON
 * and uploading it. The numbered instructions are self-explanatory, so each step
 * is just instructions and a Next button — no screenshots.
 */
export interface GooglePlaySetupWizardProps {
  name: string;
  setName: (v: string) => void;
  jsonContent: string;
  fileLabel: string | null;
  onFile: (file: File) => void;
  onPaste: (text: string) => void;
  error: string | null;
  isPending: boolean;
  canSave: boolean;
  onSave: () => void;
  onBackToProviders: () => void;
}

interface GuideStep {
  key: string;
  title: string;
  pill: string;
  open?: { label: string; href: string };
}

const STEPS: GuideStep[] = [
  {
    key: "enable",
    title: "Enable the Google Play API",
    pill: "Enable API",
    open: {
      label: "Open Google Cloud — API Library",
      href: "https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com",
    },
  },
  {
    key: "service-account",
    title: "Create a service account",
    pill: "Service account",
    open: {
      label: "Open Google Cloud — Service accounts",
      href: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    },
  },
  {
    key: "json-key",
    title: "Create & download the JSON key",
    pill: "JSON key",
  },
  {
    key: "play-access",
    title: "Grant access in Play Console",
    pill: "Play access",
    open: { label: "Open Google Play Console", href: "https://play.google.com/console" },
  },
  {
    key: "upload",
    title: "Upload the JSON to Release Flight",
    pill: "Upload",
  },
];

export function GooglePlaySetupWizard(props: GooglePlaySetupWizardProps): JSX.Element {
  const [sub, setSub] = useState(0);
  const step = STEPS[sub]!;
  const isLast = sub === STEPS.length - 1;

  function back(): void {
    if (sub === 0) props.onBackToProviders();
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

      <StepBody stepKey={step.key} props={props} />

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

      {props.error && (
        <p
          role="alert"
          className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
        >
          {props.error}
        </p>
      )}

      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={back} disabled={props.isPending}>
          ← Back
        </Button>
        {isLast ? (
          <Button variant="primary" onClick={props.onSave} disabled={!props.canSave || props.isPending}>
            {props.isPending ? <Spinner size={12} /> : "Save & test →"}
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

function StepBody({
  stepKey,
  props,
}: {
  stepKey: string;
  props: GooglePlaySetupWizardProps;
}): JSX.Element {
  switch (stepKey) {
    case "enable":
      return (
        <Instructions>
          <li>
            Open the <strong>Google Cloud Console</strong> and pick (or create) a project — e.g.{" "}
            <code>Release Flight</code>.
          </li>
          <li>
            Go to <strong>APIs &amp; Services → Library</strong> and search for{" "}
            <strong>“Google Play Android Developer API”</strong>.
          </li>
          <li>
            Open it and click <strong>Enable</strong>. (If it already says <em>Enabled</em>, you’re
            done.)
          </li>
        </Instructions>
      );
    case "service-account":
      return (
        <Instructions>
          <li>
            Go to <strong>APIs &amp; Services → Credentials → Create credentials → Service
            account</strong> (or pick <strong>Application data</strong> in the wizard).
          </li>
          <li>
            <strong>Service account name:</strong> something descriptive, e.g.{" "}
            <code>Release Flight Play Deploy</code>. The <strong>ID</strong> and email fill in
            automatically — copy the email (<code>…@your-project.iam.gserviceaccount.com</code>),
            you’ll need it in step 4.
          </li>
          <li>
            Click <strong>Create and continue</strong>, then <strong>skip</strong> the two optional
            sections and click <strong>Done</strong>. Play permissions are granted in the Play
            Console, not here.
          </li>
        </Instructions>
      );
    case "json-key":
      return (
        <>
          <Instructions>
            <li>In the service-accounts list, click the account you just created.</li>
            <li>
              Open the <strong>Keys</strong> tab → <strong>Add key → Create new key</strong>.
            </li>
            <li>
              Choose <strong>JSON</strong> → <strong>Create</strong>. A <code>.json</code> file
              downloads automatically.
            </li>
          </Instructions>
          <Callout>
            Keep this file secret — it can’t be downloaded again. It contains{" "}
            <code>client_email</code>, <code>private_key</code> and <code>project_id</code>, which is
            exactly what Release Flight needs.
          </Callout>
        </>
      );
    case "play-access":
      return (
        <>
          <Instructions>
            <li>
              Open <strong>Google Play Console</strong> → <strong>Users and permissions</strong>.
            </li>
            <li>
              Click <strong>Invite new users</strong> and paste the service-account{" "}
              <strong>email</strong> from step 2.
            </li>
            <li>
              Under <strong>Permissions</strong>, enable (per app, or account-wide):{" "}
              <strong>View app information</strong>, <strong>Manage testing track releases</strong>,
              and <strong>Manage production releases</strong> (or simply <strong>Admin</strong>).
            </li>
            <li>
              Click <strong>Invite user</strong>.
            </li>
          </Instructions>
          <Callout tone="warning">
            This step is required. Without it, uploads fail with a 401/403 even though the JSON is
            valid.
          </Callout>
        </>
      );
    case "upload":
      return <UploadStep props={props} />;
    default:
      return <></>;
  }
}

function UploadStep({ props }: { props: GooglePlaySetupWizardProps }): JSX.Element {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="space-y-4">
      <Instructions>
        <li>Give this credential a name, then upload the JSON you downloaded in step 3.</li>
        <li>
          Click <strong>Save &amp; test</strong> — Release Flight verifies the JSON can authenticate.
        </li>
      </Instructions>

      <div>
        <Label htmlFor="gp-name">Display name</Label>
        <Input
          id="gp-name"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          placeholder="Google Play Main"
          className="mt-1.5"
          autoFocus
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label>Service-account JSON</Label>
          <div className="inline-flex rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-0.5 text-[11px]">
            {(["file", "paste"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-[var(--radius-xs)] px-2 py-1 font-mono uppercase tracking-[0.06em] transition-colors",
                  mode === m
                    ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
                    : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
                )}
              >
                {m === "file" ? "Upload" : "Paste"}
              </button>
            ))}
          </div>
        </div>

        {mode === "file" ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) props.onFile(f);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-[1.5px] border-dashed px-6 py-9 text-center transition-colors",
              dragOver
                ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                : "border-[var(--stroke-input)] bg-[var(--surface-sunken)]",
            )}
          >
            <FileUp size={20} className="text-[var(--ink-tertiary)]" />
            <p className="font-body text-[13px] text-[var(--ink-secondary)]">
              Drop the .json here or{" "}
              <label className="cursor-pointer underline">
                browse
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) props.onFile(f);
                  }}
                />
              </label>
            </p>
            {props.fileLabel && (
              <p className="font-mono text-[11px] text-[var(--ink-primary)]">{props.fileLabel}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              onChange={(e) => props.onPaste(e.target.value)}
              rows={8}
              placeholder={'{\n  "type": "service_account",\n  "client_email": "...",\n  "private_key": "..."\n}'}
              className="w-full rounded-[var(--radius)] border border-[var(--stroke-input)] bg-[var(--surface-sunken)] p-2 font-mono text-[12px]"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  props.onPaste(await navigator.clipboard.readText());
                } catch {
                  /* clipboard blocked */
                }
              }}
            >
              <ClipboardPaste size={12} /> Paste from clipboard
            </Button>
            {props.fileLabel && (
              <span className="ml-2 font-mono text-[11px] text-[var(--ink-secondary)]">
                ✓ {props.fileLabel}
              </span>
            )}
          </div>
        )}
        <p className="mt-2 font-body text-[11px] text-[var(--ink-tertiary)]">
          Stored encrypted in your secret manager. Only metadata appears in the database.
        </p>
      </div>
    </div>
  );
}
