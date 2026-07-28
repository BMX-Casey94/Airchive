"use client";

import { clsx } from "clsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Local datetime value in the same string shape as `<input type="datetime-local">`. */
export function toLocalDateTimeValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function parseLocalDateTime(value: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, y, m, d, hh, mm] = match;
  return new Date(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    0,
    0,
  );
}

function formatDisplay(value: string): string {
  const date = parseLocalDateTime(value);
  if (!date) return "Select date & time";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** Monday-first weekday index (0 = Monday … 6 = Sunday). */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

interface DateTimePickerProps {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * Clickable calendar + time fields for explorer filters. Native
 * `datetime-local` forces numeric typing on many browsers; this keeps the same
 * string contract while letting the operator pick a day from a grid.
 */
export default function DateTimePicker({
  id,
  label,
  value,
  onChange,
  className,
}: DateTimePickerProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const selected = parseLocalDateTime(value);
  const [viewMonth, setViewMonth] = useState(() =>
    startOfMonth(selected ?? new Date()),
  );
  const [draftHour, setDraftHour] = useState(() =>
    pad2(selected?.getHours() ?? 0),
  );
  const [draftMinute, setDraftMinute] = useState(() =>
    pad2(selected?.getMinutes() ?? 0),
  );

  useEffect(() => {
    if (!open) return;
    const next = parseLocalDateTime(value);
    setViewMonth(startOfMonth(next ?? new Date()));
    setDraftHour(pad2(next?.getHours() ?? 0));
    setDraftMinute(pad2(next?.getMinutes() ?? 0));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cells = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const leading = mondayIndex(first);
    const totalDays = daysInMonth(viewMonth);
    const cellsOut: Array<{ day: number; date: Date } | null> = [];
    for (let i = 0; i < leading; i++) cellsOut.push(null);
    for (let day = 1; day <= totalDays; day++) {
      cellsOut.push({
        day,
        date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day),
      });
    }
    while (cellsOut.length % 7 !== 0) cellsOut.push(null);
    return cellsOut;
  }, [viewMonth]);

  const monthLabel = viewMonth.toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
  });

  function applyDate(day: Date): void {
    const hour = Math.min(23, Math.max(0, Number(draftHour) || 0));
    const minute = Math.min(59, Math.max(0, Number(draftMinute) || 0));
    const next = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      hour,
      minute,
      0,
      0,
    );
    onChange(toLocalDateTimeValue(next));
  }

  function applyTime(nextHour: string, nextMinute: string): void {
    setDraftHour(nextHour);
    setDraftMinute(nextMinute);
    if (!selected) return;
    const hour = Math.min(23, Math.max(0, Number(nextHour) || 0));
    const minute = Math.min(59, Math.max(0, Number(nextMinute) || 0));
    const next = new Date(
      selected.getFullYear(),
      selected.getMonth(),
      selected.getDate(),
      hour,
      minute,
      0,
      0,
    );
    onChange(toLocalDateTimeValue(next));
  }

  const today = new Date();

  return (
    <div ref={rootRef} className={clsx("relative space-y-1", className)}>
      <label className="text-[10px] text-hud-muted" htmlFor={inputId}>
        {label}
      </label>
      <button
        id={inputId}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={clsx(
          "flex w-56 items-center justify-between gap-2 rounded-lg border bg-space-black px-3 py-1.5 text-left font-mono text-xs transition-colors",
          "focus:border-electric-cyan focus:outline-none focus:ring-1 focus:ring-electric-cyan/30",
          open
            ? "border-electric-cyan text-white"
            : value
              ? "border-panel-border text-white hover:border-electric-cyan/40"
              : "border-panel-border text-hud-muted hover:border-electric-cyan/40",
        )}
      >
        <span className="truncate">{formatDisplay(value)}</span>
        <svg
          className="h-3.5 w-3.5 shrink-0 text-hud-muted"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`${label} calendar`}
          className="absolute left-0 top-full z-40 mt-2 w-72 rounded-xl border border-panel-border/60 bg-panel-bg/95 p-3 shadow-glow-cyan backdrop-blur-xl"
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() =>
                setViewMonth(
                  new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1),
                )
              }
              className="rounded border border-panel-border px-2 py-1 text-hud-muted transition-colors hover:border-electric-cyan/40 hover:text-electric-cyan"
            >
              ‹
            </button>
            <p className="font-mono text-xs text-white">{monthLabel}</p>
            <button
              type="button"
              aria-label="Next month"
              onClick={() =>
                setViewMonth(
                  new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1),
                )
              }
              className="rounded border border-panel-border px-2 py-1 text-hud-muted transition-colors hover:border-electric-cyan/40 hover:text-electric-cyan"
            >
              ›
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((day) => (
              <span
                key={day}
                className="text-center font-mono text-[9px] uppercase tracking-wider text-hud-muted"
              >
                {day}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, index) => {
              if (!cell) {
                return <span key={`empty-${index}`} className="h-8" />;
              }
              const isSelected =
                selected != null
                && cell.date.getFullYear() === selected.getFullYear()
                && cell.date.getMonth() === selected.getMonth()
                && cell.date.getDate() === selected.getDate();
              const isToday =
                cell.date.getFullYear() === today.getFullYear()
                && cell.date.getMonth() === today.getMonth()
                && cell.date.getDate() === today.getDate();

              return (
                <button
                  key={cell.date.toISOString()}
                  type="button"
                  onClick={() => applyDate(cell.date)}
                  className={clsx(
                    "h-8 rounded font-mono text-xs transition-colors",
                    isSelected
                      ? "bg-electric-cyan/20 text-electric-cyan ring-1 ring-electric-cyan/50"
                      : isToday
                        ? "text-white ring-1 ring-panel-border hover:bg-electric-cyan/10"
                        : "text-white/80 hover:bg-electric-cyan/10 hover:text-electric-cyan",
                  )}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-panel-border/40 pt-3">
            <label className="text-[10px] text-hud-muted" htmlFor={`${inputId}-hh`}>
              Time
            </label>
            <input
              id={`${inputId}-hh`}
              type="number"
              min={0}
              max={23}
              value={draftHour}
              onChange={(e) => applyTime(pad2(Number(e.target.value) || 0), draftMinute)}
              className="w-14 rounded border border-panel-border bg-space-black px-2 py-1 font-mono text-xs text-white focus:border-electric-cyan focus:outline-none"
            />
            <span className="text-hud-muted">:</span>
            <input
              id={`${inputId}-mm`}
              type="number"
              min={0}
              max={59}
              value={draftMinute}
              onChange={(e) => applyTime(draftHour, pad2(Number(e.target.value) || 0))}
              className="w-14 rounded border border-panel-border bg-space-black px-2 py-1 font-mono text-xs text-white focus:border-electric-cyan focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="ml-auto text-[10px] text-hud-muted transition-colors hover:text-alert-red"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-electric-cyan/40 px-2 py-1 font-mono text-[10px] text-electric-cyan transition-colors hover:bg-electric-cyan/10"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
