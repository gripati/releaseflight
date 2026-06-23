"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@marquee/ui";
import { ConnectAppWizard } from "./ConnectAppWizard";

export function AppsToolbar({ tenantSlug }: { tenantSlug: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" size="md" onClick={() => setOpen(true)}>
        <Plus size={14} /> Connect app
      </Button>
      <ConnectAppWizard open={open} onClose={() => setOpen(false)} tenantSlug={tenantSlug} />
    </>
  );
}
