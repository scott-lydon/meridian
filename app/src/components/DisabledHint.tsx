"use client";

/**
 * DisabledHint — small yellow ⓘ + one-line reason text rendered DIRECTLY
 * UNDERNEATH a disabled trade button.
 *
 * Why this exists: the trade page used to show a single consolidated
 * "Why some buttons are disabled:" panel above the order book. The
 * panel listed every active reason in one block, which forced the
 * reader to mentally match each reason back to the button it referred
 * to. The 2026-05-26 user feedback was "consolidate the panel into a
 * yellow ⓘ underneath the unavailable buy no, sell no, etc." — i.e.
 * put the reason next to the button the user is actually looking at,
 * so the cause-effect link is visual not cognitive.
 *
 * Behaviour:
 * - Renders NOTHING when `reason` is null / empty / undefined. Callers
 *   pass the reason unconditionally; this component handles the
 *   "button is enabled, no reason to show" branch internally so the
 *   call site stays free of `{reason && <DisabledHint .../>}` noise.
 * - Wraps in `text-yellow-200` on a transparent background so the hint
 *   reads as a caveat and not an action affordance. Tailwind utilities
 *   only (no custom CSS) so the bundle stays small and the theme
 *   follows the rest of the trade page.
 * - The ⓘ glyph is a plain Unicode INFORMATION SOURCE (U+24D8); no
 *   external icon dependency. It's purely decorative, so it carries
 *   aria-hidden so screen readers don't read "I" out loud before the
 *   actual reason text.
 *
 * Why a separate file: this component is reused under five buttons
 * (Buy Yes, Buy No, Sell Yes, Sell No, Mint Pair, Redeem Pair) and is
 * 100% presentational. Inlining six copies inside page.tsx would dwarf
 * the actual disabled-condition logic at each call site.
 */
export interface DisabledHintProps {
  /**
   * The one-line reason this button is currently disabled, OR null /
   * undefined / empty string if the button is enabled. The string is
   * what gets rendered next to the ⓘ; if it's falsy the component
   * renders nothing. Keep it under ~120 characters so it fits on one
   * line in the trade panel sidebar (Tailwind `text-[11px]` at the
   * default trade-panel width fits ~110 chars per line; longer strings
   * wrap which is OK but uglier).
   */
  reason?: string | null;
}

export function DisabledHint({ reason }: DisabledHintProps) {
  if (!reason) return null;
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-yellow-200/90">
      <span aria-hidden className="select-none">ⓘ</span>
      <span>{reason}</span>
    </div>
  );
}
