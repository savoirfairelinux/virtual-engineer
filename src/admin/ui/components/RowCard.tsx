import { type ReactNode, useState } from "react";

type RowCardProps = {
  children: ReactNode;
  onClick?: undefined;
  ariaLabel?: undefined;
} | {
  children: ReactNode;
  onClick: () => void;
  ariaLabel: string;
};

export function RowCard({ children, onClick, ariaLabel }: RowCardProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className={`card${onClick ? " row-card-clickable" : ""}`}
      style={{
        padding: "14px 16px",
        position: "relative",
        display: "flex", alignItems: "center", gap: "14px",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.13s var(--ease), background 0.13s var(--ease)",
        ...(hovered && onClick ? {
          borderColor: "var(--border-strong)",
          background: "var(--panel-2)",
        } : {}),
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {onClick && (
        <button type="button" className="row-card-open" aria-label={ariaLabel} onClick={onClick} />
      )}
      {children}
    </div>
  );
}
