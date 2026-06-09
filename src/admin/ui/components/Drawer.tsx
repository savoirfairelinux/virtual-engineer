import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import { TONE, type ToneKey } from "../states.ts";

/* ─── Shell ──────────────────────────────────────────────────────────── */

interface DrawerProps {
  eyebrow?: string;
  title: string;
  glyph?: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function Drawer({ eyebrow, title, glyph, onClose, footer, children }: DrawerProps) {
  // Esc key + scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.classList.add("ve-drawer-open");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.body.classList.remove("ve-drawer-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="drawer-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        {/* header */}
        <div className="drawer-head">
          {glyph && <div className="drawer-glyph">{glyph}</div>}
          <div className="titles" style={{ flex: 1, minWidth: 0 }}>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2 className="drawer-title">{title}</h2>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* body */}
        <div className="drawer-body">{children}</div>

        {/* footer */}
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ─── Detail atoms ───────────────────────────────────────────────────── */

export function DetailSection({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="detail-section">
      {label && <div className="eyebrow" style={{ marginBottom: "10px" }}>{label}</div>}
      <div className="detail-rows">{children}</div>
    </div>
  );
}

interface DetailRowProps {
  k: string;
  mono?: boolean;
  children?: React.ReactNode;
}

export function DetailRow({ k, mono, children }: DetailRowProps) {
  if (children == null || children === "") return null;
  return (
    <div className="detail-row">
      <span className="detail-key">{k}</span>
      <span className={mono ? "detail-val mono" : "detail-val"}>{children}</span>
    </div>
  );
}

/* ─── Status banner ──────────────────────────────────────────────────── */

interface StatusBannerProps {
  tone: ToneKey;
  icon: string;
  title: string;
  sub?: string;
}

export function StatusBanner({ tone, icon, title, sub }: StatusBannerProps) {
  const t = TONE[tone] ?? TONE.muted;
  const borderColor = `color-mix(in oklab, ${t.b} 28%, transparent)`;
  return (
    <div className="detail-banner">
      <span
        style={{
          width: 32, height: 32, borderRadius: "8px",
          flex: "none", display: "grid", placeItems: "center",
          color: t.c, background: t.bg,
          border: `1px solid ${borderColor}`,
        }}
      >
        <Icon name={icon} size={15} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: t.c }}>{title}</div>
        {sub && <div style={{ fontSize: "11.5px", color: "var(--text-faint)", marginTop: "1px", lineHeight: 1.4 }}>{sub}</div>}
      </div>
    </div>
  );
}
