import { useState } from "react";
import { Icon } from "./Icon.tsx";

/**
 * A password `<input>` with an inline eye button that toggles between
 * masked (`password`) and revealed (`text`) rendering.
 *
 * Styling matches {@link FieldInput} by default (sans font, panel-2 background,
 * accent focus border). Pass `style` to override — e.g. the mono login form
 * inputs — and the wrapper lifts `width`/`marginBottom` so surrounding layout
 * spacing is preserved while the eye button sits inside the field.
 */
export type PasswordFieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  value: string;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
};

export function PasswordField({ style, onFocus, onBlur, ...rest }: PasswordFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const { width, marginBottom, ...inputStyleRest } = (style ?? {}) as React.CSSProperties;

  return (
    <div
      style={{
        position: "relative",
        width: width ?? "100%",
        ...(marginBottom !== undefined ? { marginBottom } : {}),
      }}
    >
      <input
        {...rest}
        type={revealed ? "text" : "password"}
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
          ...inputStyleRest,
          paddingRight: "38px",
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; onFocus?.(e); }}
        onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; onBlur?.(e); }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={revealed ? "Hide password" : "Show password"}
        title={revealed ? "Hide password" : "Show password"}
        aria-pressed={revealed}
        onClick={() => setRevealed((v) => !v)}
        style={{
          position: "absolute", top: 0, right: 0, height: "100%",
          width: "34px", padding: 0, border: "none", background: "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer",
          color: revealed ? "var(--accent-strong)" : "var(--text-faint)",
        }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={15} />
      </button>
    </div>
  );
}
