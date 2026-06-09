import { TONE, type ToneKey } from "../states.ts";

interface BarsProps {
  data: number[];
  height?: number;
  tone?: ToneKey;
}

export function Bars({ data, height = 44, tone = "active" }: BarsProps) {
  const max = Math.max(...data, 1);
  const t = TONE[tone];
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height }}>
      {data.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${Math.max(3, (v / max) * height)}px`,
            background: i === data.length - 1
              ? t.c
              : `color-mix(in oklab, ${t.c} 40%, transparent)`,
            borderRadius: "2px",
            transition: "height 0.3s var(--ease)",
          }}
        />
      ))}
    </div>
  );
}
