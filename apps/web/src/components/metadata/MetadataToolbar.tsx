"use client";
import { useState } from "react";
import { DownloadCloud } from "lucide-react";
import { Button } from "@marquee/ui";
import { ImportMasterJsonSheet } from "./ImportMasterJsonSheet";

export function MetadataToolbar({ appId }: { appId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="md" onClick={() => setOpen(true)}>
        <DownloadCloud size={14} /> Import master JSON
      </Button>
      <ImportMasterJsonSheet appId={appId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
