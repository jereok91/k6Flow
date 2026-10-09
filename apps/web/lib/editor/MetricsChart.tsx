"use client";

import { useEffect, useRef, memo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useTheme } from "../theme";

// Canvas does not resolve CSS variables like DOM styles do.
function resolveCanvasColor(color: string): string {
  const token = /^var\((--[\w-]+)\)$/.exec(color);
  if (!token) return color;
  return getComputedStyle(document.documentElement).getPropertyValue(token[1]).trim() || "#475569";
}

function resolveCanvasSeries(series: uPlot.Series): uPlot.Series {
  const fill = typeof series.fill === "string" ? resolveCanvasColor(series.fill) : series.fill;
  return {
    ...series,
    stroke: typeof series.stroke === "string" ? resolveCanvasColor(series.stroke) : series.stroke,
    fill: typeof fill === "string" && /^#[\da-f]{6}$/i.test(fill) ? `${fill}1a` : fill,
  };
}

interface MetricsChartProps {
  title: string;
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  width?: number;
  height?: number;
  mode?: "follow" | "explore"; // follow = auto-scroll, explore = user can zoom
}

// Canvas-based high-performance chart using uPlot
export const MetricsChart = memo(function MetricsChart({
  title,
  data,
  series,
  width = 400,
  height = 200,
  mode = "follow",
}: MetricsChartProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const viewportRef = useRef<{ min: number; max: number } | null>(null);
  const dataRef = useRef(data);
  const seriesRef = useRef(series);
  dataRef.current = data;
  seriesRef.current = series;

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const opts: uPlot.Options = {
      width,
      height,
      title: title,
      cursor: {
        drag: {
          x: mode === "explore",
          y: false,
        },
      },
      scales: {
        x: {
          time: false, // Using seconds from start
        },
      },
      axes: [
        {
          stroke: resolveCanvasColor("var(--color-on-surface-variant)"),
          grid: {
            stroke: resolveCanvasColor("var(--color-surface-container-high)"),
          },
          ticks: {
            stroke: resolveCanvasColor("var(--color-surface-container-high)"),
          },
          values: (u, vals) => vals.map((v) => {
            const mins = Math.floor(v / 60);
            const secs = Math.floor(v % 60);
            return mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;
          }),
        },
        {
          stroke: resolveCanvasColor("var(--color-on-surface-variant)"),
          grid: {
            stroke: resolveCanvasColor("var(--color-surface-container-high)"),
          },
          ticks: {
            stroke: resolveCanvasColor("var(--color-surface-container-high)"),
          },
        },
      ],
      series: [
        { label: "Time" }, // x-axis
        ...seriesRef.current.map(resolveCanvasSeries),
      ],
    };

    const previousScale = viewportRef.current;
    const chart = new uPlot(opts, dataRef.current, containerRef.current);
    uplotRef.current = chart;
    if (mode === "explore" && previousScale?.min != null && previousScale?.max != null) {
      chart.setScale("x", { min: previousScale.min, max: previousScale.max });
    }

    return () => {
      const { min, max } = chart.scales.x;
      viewportRef.current = min != null && max != null ? { min, max } : null;
      chart.destroy();
      uplotRef.current = null;
    };
  }, [width, height, title, mode, theme]); // Resolve fresh canvas colors on theme changes.

  // Update data without recreating chart
  useEffect(() => {
    if (uplotRef.current && data.length > 0) {
      // Explore retains its restored/user-selected viewport on recolor and updates.
      // Follow still resets scales before applying the live trailing window below.
      uplotRef.current.setData(data, mode === "follow");

      // Auto-scroll in follow mode
      if (mode === "follow" && data[0].length > 10) {
        const xMax = data[0][data[0].length - 1];
        const xMin = Math.max(0, xMax - 60); // Show last 60 seconds
        uplotRef.current.setScale("x", { min: xMin, max: xMax });
      }
    }
  }, [data, mode, theme]);

  return (
    <div 
      ref={containerRef} 
      style={{ 
        background: "var(--color-surface-container)",
        borderRadius: "8px",
        padding: "8px",
      }}
    />
  );
});

// Pre-configured chart for requests per second
export function RpsChart({ data, width, height }: { data: number[][]; width?: number; height?: number }) {
  const alignedData: uPlot.AlignedData = data.length > 0 && data[0].length > 0
    ? [data[0], data[1]] as uPlot.AlignedData
    : [[0], [0]] as uPlot.AlignedData;

  return (
    <MetricsChart
      title="Requests/s"
      data={alignedData}
      series={[
        {
          label: "RPS",
          stroke: "var(--color-primary)",
          fill: "var(--color-primary)",
          width: 2,
        },
      ]}
      width={width}
      height={height}
    />
  );
}

// Pre-configured chart for latency
export function LatencyChart({ data, width, height }: { data: number[][]; width?: number; height?: number }) {
  const alignedData: uPlot.AlignedData = data.length > 0 && data[0].length > 0
    ? [data[0], data[1], data[2], data[3]] as uPlot.AlignedData
    : [[0], [0], [0], [0]] as uPlot.AlignedData;

  return (
    <MetricsChart
      title="Latencia (ms)"
      data={alignedData}
      series={[
        {
          label: "Avg",
          stroke: "var(--color-secondary)",
          width: 2,
        },
        {
          label: "P95",
          stroke: "var(--color-warning)",
          width: 1,
          dash: [5, 5],
        },
        {
          label: "P99",
          stroke: "var(--color-danger)",
          width: 1,
          dash: [3, 3],
        },
      ]}
      width={width}
      height={height}
    />
  );
}

// Pre-configured chart for VUs
export function VUsChart({ data, width, height }: { data: number[][]; width?: number; height?: number }) {
  const alignedData: uPlot.AlignedData = data.length > 0 && data[0].length > 0
    ? [data[0], data[1]] as uPlot.AlignedData
    : [[0], [0]] as uPlot.AlignedData;

  return (
    <MetricsChart
      title="VUs Activos"
      data={alignedData}
      series={[
        {
          label: "VUs",
          stroke: "var(--color-success)",
          fill: "var(--color-success)",
          width: 2,
        },
      ]}
      width={width}
      height={height}
    />
  );
}

// Sparkline - tiny inline chart without axes
interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({ data, width = 100, height = 24, color = "var(--color-primary)" }: SparklineProps) {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const padding = 2;

    ctx.beginPath();
    ctx.strokeStyle = resolveCanvasColor(color);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";

    data.forEach((val, i) => {
      const x = (i / (data.length - 1)) * (width - padding * 2) + padding;
      const y = height - ((val - min) / range) * (height - padding * 2) - padding;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  }, [data, width, height, color, theme]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block" }}
    />
  );
}
