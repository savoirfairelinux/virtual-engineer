import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";

interface ModalProps {
  title: string;
  sub?: string | undefined;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** "wide" bumps max-width to 760px for the provider picker grid */
  wide?: boolean | undefined;
  width?: number | undefined;
}

export function Modal({ title, sub, onClose, children, footer, wide, width }: ModalProps) {
  // Esc + scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const maxW = width ?? (wide ? 760 : 540);

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="modal"
        style={{ maxWidth: maxW }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* header */}
        <div className="modal-head">
          <div className="titles">
            <h2 className="modal-title">{title}</h2>
            {sub && <p className="modal-sub">{sub}</p>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* body */}
        <div className="modal-body">{children}</div>

        {/* footer */}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ─── Small form helpers ──────────────────────────────────────────────── */

interface FieldProps {
  label: string;
  required?: boolean | undefined;
  children: React.ReactNode;
  hint?: string | undefined;
}

export function Field({ label, required, children, hint }: FieldProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-dim)" }}>
        {label}{required && <span style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>}
      </label>
      {children}
      {hint && <span style={{ fontSize: "11.5px", color: "var(--text-ghost)" }}>{hint}</span>}
    </div>
  );
}

export function FieldInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        padding: "8px 11px",
        fontSize: "13.5px",
        fontFamily: "var(--font-sans)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--panel-2)",
        color: "var(--text)",
        outline: "none",
        width: "100%",
        ...props.style,
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; props.onFocus?.(e); }}
      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; props.onBlur?.(e); }}
    />
  );
}

export function FieldSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        padding: "8px 11px",
        fontSize: "13.5px",
        fontFamily: "var(--font-sans)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--panel-2)",
        color: "var(--text)",
        outline: "none",
        width: "100%",
        cursor: "pointer",
        ...props.style,
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; props.onFocus?.(e); }}
      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; props.onBlur?.(e); }}
    />
  );
}

export function FieldTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        padding: "8px 11px",
        fontSize: "13px",
        fontFamily: "var(--font-mono)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--panel-2)",
        color: "var(--text)",
        outline: "none",
        width: "100%",
        resize: "vertical",
        minHeight: "200px",
        lineHeight: 1.6,
        ...props.style,
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; props.onFocus?.(e); }}
      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; props.onBlur?.(e); }}
    />
  );
}

export function FormError({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div
      style={{
        padding: "10px 14px",
        background: "var(--danger-soft)",
        border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)",
        borderRadius: "var(--radius-sm)",
        fontSize: "13px",
        color: "var(--danger)",
      }}
    >
      {msg}
    </div>
  );
}

export function FormRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>{children}</div>;
}

export function FormActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "flex-end", gap: "10px",
        paddingTop: "16px", marginTop: "8px",
        borderTop: "1px solid var(--border-soft)",
      }}
    >
      {children}
    </div>
  );
}
