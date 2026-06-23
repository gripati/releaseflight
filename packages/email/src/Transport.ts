export interface EmailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html: string;
  /** Inline tag for analytics / log filtering. */
  tag?: string;
}

export interface EmailTransport {
  /** Returns the upstream message id (or generated tag for console transport). */
  send(message: EmailMessage): Promise<{ id: string }>;
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}
