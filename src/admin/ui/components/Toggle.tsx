interface ToggleProps {
  on: boolean;
  onChange?: (on: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ on, onChange, disabled }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      style={{
        width: 34, height: 19, borderRadius: 99, flex: "none",
        position: "relative", cursor: disabled ? "not-allowed" : "pointer",
        background: on ? "var(--accent)" : "var(--panel-3)",
        border: `1px solid ${on ? "transparent" : "var(--border)"}`,
        transition: "background 0.16s var(--ease)",
        padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: "absolute", top: "1.5px",
          left: on ? "16px" : "2px",
          width: 14, height: 14, borderRadius: 99,
          background: "white",
          transition: "left 0.16s var(--ease)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}
