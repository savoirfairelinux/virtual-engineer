import type { ReactNode } from "react";
import { TONE, type ToneKey } from "../states.ts";

interface TagProps {
  children: ReactNode;
  tone?: ToneKey;
  mono?: boolean;
}

export function Tag({ children, tone = "muted", mono = true }: TagProps) {
  const t = TONE[tone] ?? TONE.muted;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        color: t.c,
        background: t.bg,
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: "10px",
        fontWeight: 600,
        letterSpacing: "0.03em",
        padding: "2px 7px",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        border: `1px solid color-mix(in oklab, ${t.b} 28%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}
