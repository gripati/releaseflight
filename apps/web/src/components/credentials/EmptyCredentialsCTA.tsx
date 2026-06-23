"use client";
import { Plus } from "lucide-react";
import { Button } from "@marquee/ui";
import { useAddCredential } from "./CredentialsAddProvider";

export function EmptyCredentialsCTA(): JSX.Element {
  const open = useAddCredential();
  return (
    <Button variant="primary" size="lg" onClick={open}>
      <Plus size={14} /> Add first credential
    </Button>
  );
}
