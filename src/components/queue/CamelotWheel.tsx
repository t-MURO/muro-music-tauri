import { useMemo } from "react";
import { getCamelotColor, getCompatibleCamelotCodes } from "../../utils/camelot";

type CamelotWheelProps = {
  currentCode: string;
  selectedCode: string | null;
  onSelectCode: (code: string | null) => void;
};

const CENTER = 120;

const pointOnCircle = (radius: number, angle: number) => {
  const radians = (angle * Math.PI) / 180;
  return {
    x: CENTER + (radius * Math.cos(radians)),
    y: CENTER + (radius * Math.sin(radians)),
  };
};

const ringSegmentPath = (
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
) => {
  const outerStart = pointOnCircle(outerRadius, startAngle);
  const outerEnd = pointOnCircle(outerRadius, endAngle);
  const innerEnd = pointOnCircle(innerRadius, endAngle);
  const innerStart = pointOnCircle(innerRadius, startAngle);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
};

const segments = Array.from({ length: 12 }, (_, index) => {
  const number = index === 0 ? 12 : index;
  const centerAngle = -90 + (index * 30);
  return [
    {
      code: `${number}B`,
      path: ringSegmentPath(77, 111, centerAngle - 14.4, centerAngle + 14.4),
      label: pointOnCircle(94, centerAngle),
    },
    {
      code: `${number}A`,
      path: ringSegmentPath(45, 76, centerAngle - 14.4, centerAngle + 14.4),
      label: pointOnCircle(61, centerAngle),
    },
  ];
}).flat();

export const CamelotWheel = ({
  currentCode,
  selectedCode,
  onSelectCode,
}: CamelotWheelProps) => {
  const compatibleCodes = useMemo(
    () => new Set(getCompatibleCamelotCodes(currentCode)),
    [currentCode],
  );
  const currentColor = getCamelotColor(currentCode) ?? "var(--color-accent)";

  return (
    <div className="mx-auto w-full max-w-[280px]" data-camelot-wheel>
      <svg viewBox="0 0 240 240" className="block h-auto w-full" aria-label={`Camelot wheel, current key ${currentCode}`}>
        <circle cx={CENTER} cy={CENTER} r="112" fill="var(--color-bg-primary)" stroke="var(--color-border)" />
        {segments.map(({ code, path, label }) => {
          const isCurrent = code === currentCode;
          const isCompatible = compatibleCodes.has(code);
          const isSelected = code === selectedCode;
          const fill = getCamelotColor(code) ?? "var(--color-bg-tertiary)";
          const fillOpacity = isSelected || isCurrent ? 1 : isCompatible ? 0.9 : 0.68;
          const activate = () => onSelectCode(isSelected ? null : code);
          return (
            <g
              key={code}
              className="camelot-segment cursor-pointer outline-none"
              role="button"
              tabIndex={0}
              aria-label={`${code}${isCurrent ? ", current key" : isCompatible ? ", compatible key" : ""}`}
              aria-pressed={isSelected}
              data-camelot-code={code}
              data-camelot-current={isCurrent ? "true" : undefined}
              data-camelot-compatible={isCompatible ? "true" : undefined}
              data-camelot-selected={isSelected ? "true" : undefined}
              data-camelot-fill={fill}
              onClick={activate}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activate();
                }
              }}
            >
              <title>{code}{isCurrent ? " - current key" : isCompatible ? " - compatible mix" : ""}</title>
              <path
                d={path}
                fill={fill}
                fillOpacity={fillOpacity}
                stroke={isCurrent || isSelected ? "#ffffff" : isCompatible ? fill : "var(--color-border)"}
                strokeWidth={isCurrent || isSelected ? 2.4 : isCompatible ? 1.4 : 0.8}
                className="transition-opacity hover:opacity-80"
              />
              <text
                x={label.x}
                y={label.y}
                fill="#172126"
                fontSize="9.5"
                fontWeight={isCurrent || isSelected || isCompatible ? 700 : 500}
                textAnchor="middle"
                dominantBaseline="central"
                className="pointer-events-none select-none"
              >
                {code}
              </text>
            </g>
          );
        })}
        <g
          className="camelot-segment cursor-pointer outline-none"
          role="button"
          tabIndex={0}
          aria-label="Show automatic compatible matches"
          onClick={() => onSelectCode(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectCode(null);
            }
          }}
          data-camelot-auto
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r="40"
            fill={currentColor}
            fillOpacity={selectedCode === null ? 0.92 : 0.56}
            stroke={selectedCode === null ? "#ffffff" : "var(--color-border)"}
            strokeWidth="1.5"
          />
          <text x={CENTER} y="116" fill="#172126" fontSize="15" fontWeight="800" textAnchor="middle">{currentCode}</text>
          <text x={CENTER} y="131" fill="#334047" fontSize="8.5" fontWeight="700" letterSpacing="1" textAnchor="middle">AUTO MIX</text>
        </g>
      </svg>
      <div className="mt-1 flex items-center justify-center gap-3 text-[9px] text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full ring-1 ring-white" style={{ backgroundColor: currentColor }} />Current</span>
        <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full border border-white/80" />Compatible outline</span>
        <span>Click to filter</span>
      </div>
    </div>
  );
};
