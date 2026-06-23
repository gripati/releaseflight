"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { AddCredentialSheet } from "./AddCredentialSheet";

interface Ctx {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const CredentialsAddContext = createContext<Ctx | null>(null);

/**
 * Single source of truth for "Add credential" — only ONE AddCredentialSheet
 * is mounted (here, at the page level). Both the toolbar button and the
 * empty-state CTA just call `open()` from this context, so it's
 * impossible to have two sheets open at once or for forms to overlap.
 */
export function CredentialsAddProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <CredentialsAddContext.Provider value={{ open, close, isOpen }}>
      {children}
      <AddCredentialSheet open={isOpen} onClose={close} />
    </CredentialsAddContext.Provider>
  );
}

export function useAddCredential(): () => void {
  const ctx = useContext(CredentialsAddContext);
  if (!ctx) {
    throw new Error(
      "useAddCredential() must be called inside <CredentialsAddProvider>. " +
        "Wrap the credentials page tree in the provider.",
    );
  }
  return ctx.open;
}
