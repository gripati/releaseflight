"use client";
import { useState } from "react";
import { Sparkles, Copy, Check, AlertTriangle, FileCode2, ClipboardCheck } from "lucide-react";
import { Button, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";

interface Diagnosis {
  category: "PROJECT_CONFIG" | "CREDENTIALS" | "USER_ACTION" | "TOOLCHAIN" | "MARQUEE_BUG" | "TRANSIENT";
  confidence: number;
  rootCause: string;
  summary: string;
  explanation: string;
  userSteps: string[];
  filesToCheck: string[];
  llmPrompt: string;
}

interface Meta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

const CATEGORY: Record<Diagnosis["category"], { label: string; tone: "info" | "warning" | "danger" | "neutral" }> = {
  PROJECT_CONFIG: { label: "Project config", tone: "info" },
  CREDENTIALS: { label: "Credentials", tone: "warning" },
  USER_ACTION: { label: "Your action needed", tone: "warning" },
  TOOLCHAIN: { label: "Toolchain", tone: "neutral" },
  MARQUEE_BUG: { label: "Release Flight bug", tone: "danger" },
  TRANSIENT: { label: "Transient — retry", tone: "neutral" },
};

const TONE_VAR: Record<"info" | "warning" | "danger" | "neutral", string> = {
  info: "var(--signal)",
  warning: "var(--status-warning)",
  danger: "var(--status-danger)",
  neutral: "var(--ink-tertiary)",
};

export function BuildAnalysis({ appId, buildId }: { appId: string; buildId: string }): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [copied, setCopied] = useState(false);

  async function analyze(): Promise<void> {
    setLoading(true);
    setError(null);
    const res = await api<{ diagnosis: Diagnosis; meta: Meta }>(
      `/api/v1/apps/${appId}/builds/${buildId}/analyze`,
      { method: "POST" },
    );
    setLoading(false);
    if (res.ok) {
      setDiag(res.data.diagnosis);
      setMeta(res.data.meta);
    } else {
      setError({ code: res.code, message: res.message });
    }
  }

  function copyPrompt(): void {
    if (!diag?.llmPrompt) return;
    void navigator.clipboard.writeText(diag.llmPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  if (!diag) {
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" variant="secondary" onClick={() => void analyze()} disabled={loading}>
          {loading ? <Spinner size={12} /> : <Sparkles size={13} />}
          {loading ? "Analyzing…" : "Analyze with AI"}
        </Button>
        {error && (
          <p className="text-[12px] text-[var(--status-danger)]">
            {error.code === "AI_NOT_CONFIGURED" ? (
              <>
                No AI provider configured. Add an Anthropic / OpenAI / Gemini key in{" "}
                <strong>Credentials</strong>, then try again.
              </>
            ) : (
              error.message
            )}
          </p>
        )}
      </div>
    );
  }

  const cat = CATEGORY[diag.category];
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-3.5">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={14} className="text-[var(--signal)]" />
        <span className="font-display text-[13px] text-[var(--ink-primary)]">AI diagnosis</span>
        <span
          className="rounded-[var(--radius-pill)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em]"
          style={{ color: TONE_VAR[cat.tone], border: `1px solid ${TONE_VAR[cat.tone]}` }}
        >
          {cat.label}
        </span>
        <span className="text-[11px] text-[var(--ink-tertiary)]">{diag.confidence}% confident</span>
        {meta && (
          <span className="ml-auto text-[10px] text-[var(--ink-tertiary)]">
            {meta.provider}/{meta.model} · {meta.inputTokens + meta.outputTokens} tok ·{" "}
            {(meta.latencyMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* root cause */}
      <div>
        <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">Root cause</p>
        <p className="mt-0.5 text-[13px] font-medium text-[var(--ink-primary)]">{diag.rootCause}</p>
      </div>

      {/* explanation */}
      {diag.explanation && (
        <p className="whitespace-pre-wrap text-[12px] leading-[1.6] text-[var(--ink-secondary)]">
          {diag.explanation}
        </p>
      )}

      {/* user steps */}
      {diag.userSteps.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
            <AlertTriangle size={11} /> What to do
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-[1.55] text-[var(--ink-secondary)]">
            {diag.userSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {/* files to check */}
      {diag.filesToCheck.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FileCode2 size={12} className="text-[var(--ink-tertiary)]" />
          {diag.filesToCheck.map((f, i) => (
            <code
              key={i}
              className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-secondary)]"
            >
              {f}
            </code>
          ))}
        </div>
      )}

      {/* copy-paste LLM fix prompt — the headline */}
      {diag.llmPrompt.trim() && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
              Paste into Claude Code / Cursor (in your project)
            </p>
            <Button size="sm" variant={copied ? "secondary" : "primary"} onClick={copyPrompt}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy prompt"}
            </Button>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-sunken)] p-2.5 font-mono text-[11px] leading-[1.5] text-[var(--ink-secondary)]">
            {diag.llmPrompt}
          </pre>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void analyze()} disabled={loading}>
          {loading ? <Spinner size={12} /> : <ClipboardCheck size={12} />} Re-analyze
        </Button>
      </div>
    </div>
  );
}
