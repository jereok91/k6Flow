"use client";

import { useEffect, useRef, memo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const dataRef = useRef(data);

  // Update data ref when data changes
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

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
          stroke: "var(--color-on-surface-variant)",
          grid: {
            stroke: "var(--color-surface-container-high)",
          },
          ticks: {
            stroke: "var(--color-surface-container-high)",
          },
          values: (u, vals) => vals.map((v) => {
            const mins = Math.floor(v / 60);
            const secs = Math.floor(v % 60);
            return mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;
          }),
        },
        {
          stroke: "var(--color-on-surface-variant)",
          grid: {
            stroke: "var(--color-surface-container-high)",
          },
          ticks: {
            stroke: "var(--color-surface-container-high)",
          },
        },
      ],
      series: [
        { label: "Time" }, // x-axis
        ...series,
      ],
    };

    uplotRef.current = new uPlot(opts, data, containerRef.current);

    return () => {
      uplotRef.current?.destroy();
      uplotRef.current = null;
    };
  }, [width, height, title, mode]); // Don't include series/data to avoid recreation

  // Update data without recreating chart
  useEffect(() => {
    if (uplotRef.current && data.length > 0) {
      uplotRef.current.setData(data);

      // Auto-scroll in follow mode
      if (mode === "follow" && data[0].length > 10) {
        const xMax = data[0][data[0].length - 1];
        const xMin = Math.max(0, xMax - 60); // Show last 60 seconds
        uplotRef.current.setScale("x", { min: xMin, max: xMax });
      }
    }
  }, [data, mode]);

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
          stroke: "#8b5cf6", // violet
          fill: "rgba(139, 92, 246, 0.1)",
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
          stroke: "#06b6d4", // cyan
          width: 2,
        },
        {
          label: "P95",
          stroke: "#f59e0b", // amber
          width: 1,
          dash: [5, 5],
        },
        {
          label: "P99",
          stroke: "#ef4444", // red
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
          stroke: "#10b981", // emerald
          fill: "rgba(16, 185, 129, 0.1)",
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

export function Sparkline({ data, width = 100, height = 24, color = "#8b5cf6" }: SparklineProps) {
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
    ctx.strokeStyle = color;
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
  }, [data, width, height, color]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block" }}
    />
  );
}
