"use client";

/**
 * InfoTip — small ⓘ icon that opens an inline popover explaining what
 * happens when the user clicks the action it's attached to.
 *
 * Why this exists: Meridian's NO trading flow does not match an interface a
 * traditional order-book trader expects. There is no NO book; Buy No
 * atomically mints a pair and sells the YES against the single best resting
 * bid. Hiding that mechanism inside a `title=` hover tooltip means desktop
 * users only see it on hover and touch users never see it at all. The InfoTip
 * surfaces the actual on-chain behavior as a tap-to-reveal popover, anchored
 * to the action it explains, so users learn the protocol while they trade.
 *
 * Design constraints:
 * - Tap (touch) and click (mouse) both open. Click outside or ESC closes.
 * - Renders absolutely; the parent must have `position: relative`.
 * - Z-index 30 so it overlays the trade form and book panels.
 * - Caller passes `side="top"` (popover above the icon) or "bottom" (below),
 *   so a 2x2 button grid can show top-row popovers upward and bottom-row
 *   popovers downward without colliding with the next row of UI.
 * - Title is one short noun phrase; body is a few short sentences. Code
 *   identifiers (instruction names, parameter names, account names) are
 *   rendered in monospace so a curious user can search the repo for them.
 *
 * Accessibility: the toggle is a real <button> with aria-expanded and an
 * aria-label; the popover has role="dialog" with aria-labelledby pointing at
 * the title. ESC and click-outside both close the popover and return focus
 * to the toggle.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface InfoTipProps {
  /** Short label, shown bold at the top of the popover. */
  title: string;
  /** Rich content. Use <p> and <code> children freely. */
  children: ReactNode;
  /**
   * Which side of the icon the popover opens to. Default "top" because the
   * trade form sits in a narrow sidebar where the icon usually has room above
   * but not below.
   */
  side?: "top" | "bottom";
  /**
   * Optional extra classes on the wrapping span (e.g. positioning offsets if
   * absolute placement on the parent is awkward).
   */
  className?: string;
  /**
   * Aria label override. Defaults to "Learn how {title} works".
   */
  ariaLabel?: string;
}

export function InfoTip({
  title,
  children,
  side = "top",
  className,
  ariaLabel,
}: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // Close on outside click. Bound only while open so we don't pay the cost
  // on idle popovers across the page.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current) return;
      const target = event.target as Node | null;
      if (target && wrapperRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
    };
  }, [open]);

  // Close on ESC, return focus to the toggle so keyboard users don't lose
  // their place.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const popoverPositionClasses =
    side === "top" ? "bottom-full mb-2" : "top-full mt-2";

  return (
    <span
      ref={wrapperRef}
      className={[
        "relative inline-flex items-center",
        className ?? "",
      ].join(" ")}
    >
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-label={ariaLabel ?? `Learn how ${title} works`}
        onClick={(e) => {
          // Stop propagation so a parent like a button group's click handler
          // does NOT fire. The trade buttons are siblings, not parents, so
          // this is defensive; harmless if no parent listens.
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-bold leading-none opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent/60"
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-labelledby={titleId}
          className={[
            "absolute right-0 z-30 w-72 rounded-lg border border-panel bg-bg p-3 text-left text-xs shadow-xl shadow-black/50",
            popoverPositionClasses,
          ].join(" ")}
        >
          <p id={titleId} className="mb-1 font-semibold text-text">
            {title}
          </p>
          <div className="space-y-2 text-muted">{children}</div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              toggleRef.current?.focus();
            }}
            className="mt-2 text-[10px] uppercase tracking-wider text-accent hover:text-text"
          >
            Close
          </button>
        </div>
      )}
    </span>
  );
}
