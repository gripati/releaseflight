"use client";
import { useState } from "react";
import { ExternalLink, FileUp, ClipboardPaste } from "lucide-react";
import { Button, Input, Label, Spinner, cn } from "@marquee/ui";
import { GuidePipeline, Instructions, Callout } from "./guideKit";

/**
 * No-code, step-by-step guide for creating an App Store Connect API key
 * (.p8 + Key ID + Issuer ID) and uploading it. The numbered instructions are
 * self-explanatory, so the guide carries no screenshots.
 */
export interface AppleSetupWizardProps {
  name: string;
  setName: (v: string) => void;
  keyId: string;
  setKeyId: (v: string) => void;
  issuerId: string;
  setIssuerId: (v: string) => void;
  pemContent: string;
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
    key: "open-keys",
    title: "Open the API Keys page",
    pill: "API keys",
    open: {
      label: "Open App Store Connect — Keys",
      href: "https://appstoreconnect.apple.com/access/integrations/api",
    },
  },
  {
    key: "generate",
    title: "Generate an API key",
    pill: "Generate",
  },
  {
    key: "download",
    title: "Download the .p8 & copy the Key ID",
    pill: ".p8 + Key ID",
  },
  {
    key: "issuer",
    title: "Copy the Issuer ID",
    pill: "Issuer ID",
  },
  {
    key: "upload",
    title: "Enter the details in Release Flight",
    pill: "Upload",
  },
];

export function AppleSetupWizard(props: AppleSetupWizardProps): JSX.Element {
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
  props: AppleSetupWizardProps;
}): JSX.Element {
  switch (stepKey) {
    case "open-keys":
      return (
        <>
          <Instructions>
            <li>
              Open <strong>App Store Connect</strong> (appstoreconnect.apple.com).
            </li>
            <li>
              Go to <strong>Users and Access → Integrations</strong> tab →{" "}
              <strong>App Store Connect API</strong> (Team Keys).
            </li>
          </Instructions>
          <Callout>
            You need the <strong>Admin</strong> or <strong>Account Holder</strong> role to create
            keys. If you don’t see the Keys page, ask your team’s Account Holder.
          </Callout>
        </>
      );
    case "generate":
      return (
        <Instructions>
          <li>
            Click <strong>Generate API Key</strong> (or the <strong>+</strong> button).
          </li>
          <li>
            <strong>Name:</strong> something descriptive, e.g. <code>Release Flight Deploy</code>.
          </li>
          <li>
            <strong>Access:</strong> choose <strong>App Manager</strong> (enough for metadata,
            builds and TestFlight) — or <strong>Admin</strong> for everything.
          </li>
          <li>
            Click <strong>Generate</strong>.
          </li>
        </Instructions>
      );
    case "download":
      return (
        <>
          <Instructions>
            <li>
              Next to the new key, click <strong>Download API Key</strong> — it saves{" "}
              <code>AuthKey_XXXXXXXXXX.p8</code>.
            </li>
            <li>
              Copy the <strong>Key ID</strong> shown in the row (10 characters, e.g.{" "}
              <code>ABC123DEF4</code>).
            </li>
          </Instructions>
          <Callout tone="warning">
            The <code>.p8</code> can only be downloaded <strong>once</strong>. Keep it safe — if you
            lose it, you must revoke the key and generate a new one.
          </Callout>
        </>
      );
    case "issuer":
      return (
        <Instructions>
          <li>
            At the <strong>top of the Keys page</strong>, find <strong>Issuer ID</strong>.
          </li>
          <li>
            Click to copy it — it’s a UUID like{" "}
            <code>57246542-96fe-1a63-e053-0824d011072a</code>. It’s the same for every key in your
            team.
          </li>
        </Instructions>
      );
    case "upload":
      return <UploadStep props={props} />;
    default:
      return <></>;
  }
}

function UploadStep({ props }: { props: AppleSetupWizardProps }): JSX.Element {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="space-y-4">
      <Instructions>
        <li>Fill in the three values from the previous steps, then upload the .p8.</li>
        <li>
          Click <strong>Save &amp; test</strong> — Release Flight verifies the key can authenticate.
        </li>
      </Instructions>

      <div>
        <Label htmlFor="ap-name">Display name</Label>
        <Input
          id="ap-name"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          placeholder="Apple Prod"
          className="mt-1.5"
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="ap-keyid">Key ID</Label>
          <Input
            id="ap-keyid"
            value={props.keyId}
            onChange={(e) => props.setKeyId(e.target.value.toUpperCase())}
            placeholder="ABC123DEF4"
            className="mt-1.5 font-mono"
          />
        </div>
        <div>
          <Label htmlFor="ap-issuer">Issuer ID</Label>
          <Input
            id="ap-issuer"
            value={props.issuerId}
            onChange={(e) => props.setIssuerId(e.target.value.toLowerCase())}
            placeholder="57246542-96fe-…"
            className="mt-1.5 font-mono"
          />
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label>Private key (.p8)</Label>
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
              Drop the AuthKey_….p8 here or{" "}
              <label className="cursor-pointer underline">
                browse
                <input
                  type="file"
                  accept=".p8,.pem,application/octet-stream,application/x-pem-file"
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
              placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
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
