"use client";
import { Plus } from "lucide-react";
import { Button } from "@marquee/ui";
import { useAddCredential } from "./CredentialsAddProvider";

export function CredentialsToolbar(): JSX.Element {
  const open = useAddCredential();
  return (
    <Button variant="primary" size="md" onClick={open}>
      <Plus size={14} /> Add credential
    </Button>
  );
}
