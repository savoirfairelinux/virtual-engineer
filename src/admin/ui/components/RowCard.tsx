import { type ReactNode, useState } from "react";

interface RowCardProps {
  children: ReactNode;
  onClick?: () => void;
}

export function RowCard({ children, onClick }: RowCardProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      className="card"
      style={{
        padding: "14px 16px",
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
      {children}
    </div>
  );
}
