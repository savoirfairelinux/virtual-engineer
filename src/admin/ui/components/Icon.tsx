import React from "react";

const ICON_SVG_RAW = import.meta.glob("../icons/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function extractPathData(svg: string): string {
  const match = svg.match(/<path[^>]*\sd="([^"]+)"/);
  return match?.[1] ?? "";
}

const PATHS: Record<string, string> = Object.fromEntries(
  Object.entries(ICON_SVG_RAW).map(([filePath, svg]) => {
    const iconName = (filePath.split("/").pop() ?? "dot.svg").replace(/\.svg$/, "");
    return [iconName, extractPathData(svg)];
  })
);

interface IconProps {
  name: string;
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function Icon({ name, size = 16, style, className }: IconProps) {
  const d = PATHS[name] ?? PATHS["dot"] ?? "";
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="currentColor"
      style={style} className={className} aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
