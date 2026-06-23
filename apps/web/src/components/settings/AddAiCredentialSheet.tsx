"use client";

import { useState } from "react";
import { Button, Input, Label, Spinner } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

type ProviderKind = "claude" | "openai" | "gemini";

const PROVIDER_TO_CREDENTIAL_KIND: Record<ProviderKind, "AI_ANTHROPIC" | "AI_OPENAI" | "AI_GEMINI"> = {
  claude: "AI_ANTHROPIC",
  openai: "AI_OPENAI",
  gemini: "AI_GEMINI",
};

const PROVIDER_PRETTY: Record<ProviderKind, { label: string; helper: string; placeholder: string; modelHint: string }> = {
  claude: {
    label: "Anthropic Claude",
    helper:
      "Find your API key at console.anthropic.com → API Keys. The key starts with sk-ant-.",
    placeholder: "sk-ant-…",
    modelHint: "claude-sonnet-4-6 (default), claude-opus-4-7, …",
  },
  openai: {
    label: "OpenAI",
    helper: "Find your API key at platform.openai.com → API Keys. The key starts with sk-.",
    placeholder: "sk-…",
    modelHint: "gpt-4o-mini (default), gpt-4o, gpt-4.1, …",
  },
  gemini: {
    label: "Google Gemini",
    helper: "Get an API key from aistudio.google.com/apikey. AI Studio keys start with AIza.",
    placeholder: "AIza…",
    modelHint: "gemini-2.0-flash (default), gemini-1.5-pro, …",
  },
};

interface Props {
  kind: ProviderKind;
  open: boolean;
  onClose: () => void;
  onSaved: (credentialId: string, name: string) => void;
}

export function AddAiCredentialSheet({ kind, open, onClose, onSaved }: Props): JSX.Element {
  const pretty = PROVIDER_PRETTY[kind];
  const [name, setName] = useState(pretty.label);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSave(): Promise<void> {
    setBusy(true);
    const body: Record<string, string> = {
      kind: PROVIDER_TO_CREDENTIAL_KIND[kind],
      name: name.trim(),
      apiKey: apiKey.trim(),
    };
    if (model.trim().length > 0) body.model = model.trim();

    const res = await api<{ id: string; name: string }>("/api/v1/credentials", {
      method: "POST",
      body,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Could not save credential", { description: res.message });
      return;
    }
    toast.success(`${pretty.label} key saved`);
    onSaved(res.data.id, res.data.name);
  }

  const valid = name.trim().length > 0 && apiKey.trim().length >= 8;

  return (
    <Sheet open={open} onClose={onClose} title={`Add ${pretty.label} key`} width={520}>
      <div className="space-y-4">
        <p className="font-body text-[13px] text-[var(--ink-secondary)]">{pretty.helper}</p>
        <div>
          <Label htmlFor="cred-name">Display name</Label>
          <Input
            id="cred-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1.5"
            maxLength={80}
          />
        </div>
        <div>
          <Label htmlFor="cred-key">API key</Label>
          <Input
            id="cred-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={pretty.placeholder}
            className="mt-1.5 font-mono text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1.5 font-body text-[11px] text-[var(--ink-tertiary)]">
            Stored encrypted in your secret manager — never appears in DB or logs.
          </p>
        </div>
        <div>
          <Label htmlFor="cred-model">Model override (optional)</Label>
          <Input
            id="cred-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={pretty.modelHint}
            className="mt-1.5 font-mono text-[12px]"
            maxLength={80}
          />
          <p className="mt-1.5 font-body text-[11px] text-[var(--ink-tertiary)]">
            Leave blank to use the recommended default.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={!valid || busy}>
            {busy ? <Spinner size={12} /> : "Save key"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
