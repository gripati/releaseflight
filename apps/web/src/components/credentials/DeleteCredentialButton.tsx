"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

interface Props {
  credentialId: string;
  credentialName: string;
  appCount: number;
}

/**
 * Two-step destructive button: click once → confirm prompt + countdown,
 * click again → fires DELETE. Cancel reverts.
 */
export function DeleteCredentialButton({
  credentialId,
  credentialName,
  appCount,
}: Props): JSX.Element {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  function fire(): void {
    if (!armed) {
      setArmed(true);
      // Auto-disarm after 4s if not confirmed
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    startTransition(() => {
      void (async () => {
        const result = await api(`/api/v1/credentials/${credentialId}`, {
          method: "DELETE",
        });
        if (!result.ok) {
          toast.error(result.message);
          setArmed(false);
          return;
        }
        toast.success(`Deleted "${credentialName}"`);
        router.refresh();
      })();
    });
  }

  if (appCount > 0) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title={`Used by ${appCount} app${appCount === 1 ? "" : "s"} — disconnect first`}
      >
        <Trash2 size={12} /> Delete
      </Button>
    );
  }

  return (
    <Button
      variant={armed ? "destructive" : "ghost"}
      size="sm"
      onClick={fire}
      disabled={pending}
    >
      {pending ? (
        <Spinner size={12} />
      ) : (
        <>
          <Trash2 size={12} />
          {armed ? "Confirm delete" : "Delete"}
        </>
      )}
    </Button>
  );
}
