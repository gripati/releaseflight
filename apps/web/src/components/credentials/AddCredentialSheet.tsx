"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ComponentType } from "react";
import { FileUp, CheckCircle2, AlertTriangle, ClipboardPaste, Database, type LucideIcon } from "lucide-react";
import { Button, Input, Label, Spinner, Stamp, Textarea, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { AppleLogo, GooglePlayLogo } from "@/components/icons/BrandIcons";
import { api } from "@/lib/apiClient";
import { GooglePlaySetupWizard } from "./GooglePlaySetupWizard";
import { AppleSetupWizard } from "./AppleSetupWizard";

type Kind = "APPLE" | "GOOGLE" | "ASO_RESEARCH_MCP";

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_OPTIONS: {
  kind: Kind;
  label: string;
  description: string;
  Icon: LucideIcon | ComponentType<{ size?: number; className?: string }>;
}[] = [
  { kind: "APPLE", label: "Apple — App Store Connect", description: "Metadata, builds, sales reports · .p8 private key + Issuer ID", Icon: AppleLogo },
  { kind: "ASO_RESEARCH_MCP", label: "ASO Research (Astro MCP)", description: "Keyword popularity · difficulty · max reach chance · rank · MCP endpoint URL", Icon: Database },
  { kind: "GOOGLE", label: "Google Play", description: "Android metadata + builds · Service-account JSON", Icon: GooglePlayLogo },
];

export function AddCredentialSheet({ open, onClose }: Props): JSX.Element {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  // ASO Research MCP-only — just the endpoint URL. Authentication,
  // tool discovery and protocol handshake are handled automatically by
  // AstroMcpClient on first use.
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [pemContent, setPemContent] = useState("");
  const [jsonContent, setJsonContent] = useState("");
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [inputMode, setInputMode] = useState<"file" | "paste">("file");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset(): void {
    setStep(1);
    setKind(null);
    setName("");
    setKeyId("");
    setIssuerId("");
    setMcpEndpoint("");
    setPemContent("");
    setJsonContent("");
    setFileLabel(null);
    setInputMode("file");
    setError(null);
    setTestResult(null);
  }

  const usesPem = kind === "APPLE";
  // Apple & Google Play get a richer, no-code, step-by-step setup pipeline.
  const googleGuide = step === 2 && kind === "GOOGLE";
  const appleGuide = step === 2 && kind === "APPLE";
  const guided = googleGuide || appleGuide;

  function applyPaste(text: string): void {
    setError(null);
    setTestResult(null);
    if (!kind) return;
    if (usesPem) {
      if (!text.includes("BEGIN") || !text.includes("PRIVATE KEY")) {
        setError("Pasted text must be a PEM-encoded private key (BEGIN…END PRIVATE KEY).");
        return;
      }
      setPemContent(text);
      setFileLabel("Pasted PEM");
    } else {
      try {
        const parsed = JSON.parse(text) as { client_email?: string; private_key?: string };
        if (!parsed.client_email || !parsed.private_key) {
          setError("Service-account JSON missing client_email or private_key");
          return;
        }
        setJsonContent(text);
        setFileLabel("Pasted JSON");
      } catch {
        setError("Pasted text is not valid JSON");
      }
    }
  }

  function close(): void {
    reset();
    onClose();
  }

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setTestResult(null);
    const text = await file.text();
    setFileLabel(`${file.name} · ${(file.size / 1024).toFixed(1)} KB`);
    if (usesPem) {
      if (!text.includes("BEGIN") || !text.includes("PRIVATE KEY")) {
        setError("Apple key must be a PEM-encoded .p8 file");
        return;
      }
      setPemContent(text);
    } else {
      try {
        const parsed = JSON.parse(text) as { client_email?: string; private_key?: string };
        if (!parsed.client_email || !parsed.private_key) {
          setError("Service-account JSON missing client_email or private_key");
          return;
        }
        setJsonContent(text);
      } catch {
        setError("Selected file is not valid JSON");
      }
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  function save(): void {
    if (!kind) return;
    setError(null);
    startTransition(() => {
      void (async () => {
        const body =
          kind === "APPLE"
            ? { kind, name, keyId, issuerId, privateKeyPem: pemContent }
            : kind === "ASO_RESEARCH_MCP"
              ? // Astro MCP — only the endpoint is user-visible. Auth +
                // tool name + protocol handshake are auto-handled by
                // AstroMcpClient on first use.
                {
                  kind,
                  name,
                  endpoint: mcpEndpoint.trim(),
                }
              : { kind, name, serviceAccountJson: jsonContent };
        const result = await api<{ id: string; name: string; kind: Kind }>("/api/v1/credentials", {
          method: "POST",
          body,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        // Auto-trigger test connection
        const test = await api<{ ok: boolean; message: string }>(
          `/api/v1/credentials/${result.data.id}/test`,
          { method: "POST" },
        );
        if (test.ok) setTestResult(test.data);
        else setTestResult({ ok: false, message: test.message });

        // Refresh server data and stay on step 3 so user sees the result
        router.refresh();
        setStep(3);
      })();
    });
  }

  const canProceedStep2 =
    kind === "APPLE"
      ? name.length > 0 && keyId.length > 0 && issuerId.length > 0 && pemContent.length > 0
      : kind === "ASO_RESEARCH_MCP"
        ? // Just name + a valid URL. Everything else (auth, tool
          // discovery) is handled by AstroMcpClient at call time.
          name.length > 0 && /^https?:\/\//.test(mcpEndpoint.trim())
        : name.length > 0 && jsonContent.length > 0;

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Add credential"
      subtitle={
        googleGuide
          ? "Google Play setup"
          : appleGuide
            ? "App Store Connect setup"
            : `Step ${step.toString()} of 3`
      }
      width={620}
    >
      {/* Progress dots (the guided providers render their own richer pipeline) */}
      {!guided && (
        <div className="mb-6 flex items-center gap-2">
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                step >= n ? "bg-[var(--signal)]" : "bg-[var(--stroke-default)]",
              )}
            />
          ))}
        </div>
      )}

      {googleGuide && (
        <GooglePlaySetupWizard
          name={name}
          setName={setName}
          jsonContent={jsonContent}
          fileLabel={fileLabel}
          onFile={(f) => void handleFile(f)}
          onPaste={applyPaste}
          error={error}
          isPending={isPending}
          canSave={canProceedStep2}
          onSave={save}
          onBackToProviders={() => setStep(1)}
        />
      )}

      {appleGuide && (
        <AppleSetupWizard
          name={name}
          setName={setName}
          keyId={keyId}
          setKeyId={setKeyId}
          issuerId={issuerId}
          setIssuerId={setIssuerId}
          pemContent={pemContent}
          fileLabel={fileLabel}
          onFile={(f) => void handleFile(f)}
          onPaste={applyPaste}
          error={error}
          isPending={isPending}
          canSave={canProceedStep2}
          onSave={save}
          onBackToProviders={() => setStep(1)}
        />
      )}

      {step === 1 && (
        <section className="space-y-2">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              onClick={() => {
                setKind(opt.kind);
                setStep(2);
              }}
              className={cn(
                "flex w-full items-center gap-4 rounded-[var(--radius)] border border-[var(--stroke-default)] p-4 text-left",
                "transition-all hover:bg-[var(--surface-tinted)] hover:-translate-y-px",
              )}
            >
              <opt.Icon size={20} />
              <span className="flex-1">
                <span className="block font-display text-lg leading-tight">{opt.label}</span>
                <span className="block font-body text-[12px] text-[var(--ink-secondary)]">
                  {opt.description}
                </span>
              </span>
              <span className="font-mono text-xs text-[var(--ink-tertiary)]">→</span>
            </button>
          ))}
        </section>
      )}

      {step === 2 && kind === "ASO_RESEARCH_MCP" && (
        <section className="space-y-4">
          <div>
            <Label htmlFor="name">Display name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Astro Desktop"
              className="mt-1.5"
              autoFocus
            />
          </div>

          {kind === "ASO_RESEARCH_MCP" && (
            <>
              <div className="rounded-[var(--radius-xs)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.10em] text-[var(--ink-tertiary)]">
                  Astro Desktop
                </p>
                <p className="mt-1 font-body text-[12px] leading-[1.55] text-[var(--ink-secondary)]">
                  Paste the URL of your running Astro Desktop instance. Authentication
                  + tool discovery are handled automatically — the autopilot calls
                  Astro's real tools (search rankings, keyword suggestions, competitor
                  mining) on demand.
                </p>
              </div>
              <div>
                <Label htmlFor="mcpEndpoint">MCP endpoint URL</Label>
                <Input
                  id="mcpEndpoint"
                  type="url"
                  value={mcpEndpoint}
                  onChange={(e) => setMcpEndpoint(e.target.value)}
                  placeholder="http://127.0.0.1:8089/mcp"
                  className="mt-1.5 font-mono text-[12px]"
                  autoFocus
                />
                <p className="mt-1 font-body text-[10px] text-[var(--ink-tertiary)]">
                  Astro Desktop default: <code className="font-mono">http://127.0.0.1:8089/mcp</code>.
                  Click <strong>Save &amp; test</strong> to verify the connection.
                </p>
              </div>
            </>
          )}

          {kind !== "ASO_RESEARCH_MCP" && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>{usesPem ? (kind === "APPLE" ? "Private key (.p8)" : "Private key (PEM)") : "Service-account JSON"}</Label>
              <div className="inline-flex rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setInputMode("file")}
                  className={cn(
                    "rounded-[var(--radius-xs)] px-2 py-1 font-mono uppercase tracking-[0.06em] transition-colors",
                    inputMode === "file"
                      ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
                      : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
                  )}
                >
                  Upload
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode("paste")}
                  className={cn(
                    "rounded-[var(--radius-xs)] px-2 py-1 font-mono uppercase tracking-[0.06em] transition-colors",
                    inputMode === "paste"
                      ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
                      : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
                  )}
                >
                  Paste
                </button>
              </div>
            </div>

            {inputMode === "file" ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-[var(--radius)]",
                  "border-[1.5px] border-dashed px-6 py-10 text-center transition-colors",
                  dragOver
                    ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                    : "border-[var(--stroke-input)] bg-[var(--surface-sunken)]",
                )}
              >
                <FileUp size={20} className="text-[var(--ink-tertiary)]" />
                <p className="font-body text-[13px] text-[var(--ink-secondary)]">
                  Drop file here or{" "}
                  <label className="cursor-pointer underline">
                    browse
                    <input
                      type="file"
                      accept={usesPem ? ".p8,.pem,application/octet-stream,application/x-pem-file" : ".json,application/json"}
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                      }}
                    />
                  </label>
                </p>
                {fileLabel && (
                  <p className="font-mono text-[11px] text-[var(--ink-primary)]">{fileLabel}</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Textarea
                  value={usesPem ? pemContent : jsonContent}
                  onChange={(e) => applyPaste(e.target.value)}
                  rows={10}
                  placeholder={
                    usesPem
                      ? "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"
                      : '{\n  "type": "service_account",\n  "client_email": "...",\n  "private_key": "..."\n}'
                  }
                  className="font-mono text-[12px]"
                  spellCheck={false}
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        applyPaste(text);
                      } catch {
                        setError("Clipboard not accessible — paste directly into the box above.");
                      }
                    }}
                  >
                    <ClipboardPaste size={12} /> Paste from clipboard
                  </Button>
                  {fileLabel && (
                    <span className="font-mono text-[11px] text-[var(--ink-secondary)]">
                      ✓ {fileLabel}
                    </span>
                  )}
                </div>
              </div>
            )}

            <p className="mt-2 font-body text-[11px] text-[var(--ink-tertiary)]">
              Stored encrypted in your secret manager. Only metadata appears in the database.
            </p>
          </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
            >
              {error}
            </p>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={isPending}>
              ← Back
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={!canProceedStep2 || isPending}
            >
              {isPending ? <Spinner size={12} /> : "Save & test →"}
            </Button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-6">
          {testResult ? (
            testResult.ok ? (
              <div className="rounded-[var(--radius)] bg-[var(--status-success-tint)] p-6 text-center">
                <CheckCircle2 size={32} className="mx-auto text-[var(--status-success)]" />
                <Stamp variant="success" className="mt-3">
                  CONNECTED
                </Stamp>
                <h3
                  className="mt-4 font-display text-xl"
                  style={{ fontVariationSettings: "'wght' 500" }}
                >
                  {kind} credential saved
                </h3>
                <p className="mt-2 font-body text-[13px] text-[var(--ink-secondary)]">
                  {testResult.message}
                </p>
              </div>
            ) : (
              <div className="rounded-[var(--radius)] bg-[var(--status-warning-tint)] p-6">
                <AlertTriangle size={24} className="text-[var(--status-warning)]" />
                <Stamp variant="warning" className="mt-3">
                  SAVED · TEST FAILED
                </Stamp>
                <p className="mt-3 font-body text-[13px]">
                  The credential was saved but the test request failed:
                </p>
                <pre className="mt-2 max-h-32 overflow-auto rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] p-3 font-mono text-[11px]">
                  {testResult.message}
                </pre>
                <p className="mt-3 font-body text-[12px] text-[var(--ink-secondary)]">
                  Fix the key on the Apple / Google portal and try “Test connection” from the
                  credentials list.
                </p>
              </div>
            )
          ) : (
            <div className="text-center">
              <Spinner size={20} />
              <p className="mt-3 font-body text-[13px] text-[var(--ink-secondary)]">
                Testing connection…
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </section>
      )}
    </Sheet>
  );
}
