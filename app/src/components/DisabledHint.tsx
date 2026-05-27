"use client";

/**
 * DisabledHint — small clickable yellow ⓘ icon rendered next to a
 * disabled trade button. Click reveals the reason in a popover; the
 * collapsed (icon-only) state is what the user sees by default so the
 * trade panel stays uncluttered.
 *
 * Why this exists: an earlier version rendered the full reason inline
 * as wrapped yellow text directly under each disabled button. With
 * four buttons all disabled at once (the common Meridian state when a
 * fresh wallet lands on an illiquid market) the trade panel grew an
 * extra ~10 lines of yellow caveat text that pushed the actual buy /
 * sell affordances below the fold. The 2026-05-26 user feedback was
 * "you've got to collapse all these 'extra looking' texts. They are
 * cluttering the ui." The fix: collapse the reason text behind a
 * single click. The icon itself is unobtrusive (small, low-contrast
 * border, opacity 70 until hover) so an enabled UI still scans
 * cleanly while the affordance to learn WHY a specific button is
 * disabled is one click away.
 *
 * Reuses the existing InfoTip primitive for the popover behavior
 * (click outside / ESC to close, focus management, accessibility).
 * The only visual difference is the yellow tint (`text-yellow-300`)
 * which is the same hue used elsewhere for "constraint / caveat" UX
 * so the icon reads as "there's a reason this is disabled" at a
 * glance, distinct from the green / red mechanism-explanation icons
 * already on every button.
 *
 * Behaviour:
 * - Renders NOTHING when `reason` is null / empty / undefined. Callers
 *   pass the reason unconditionally; this component handles the
 *   "button is enabled, no icon to show" branch internally so the
 *   call site stays free of `{reason && <DisabledHint .../>}` noise.
 * - The popover opens BELOW the icon (side="bottom") because the
 *   icon sits inside the trade panel which has ample room below but
 *   often nothing above (top-row buttons are flush with the panel
 *   header).
 */

import { InfoTip } from "./InfoTip";

export interface DisabledHintProps {
  /**
   * The one-line reason this button is currently disabled, OR null /
   * undefined / empty string if the button is enabled. Rendered inside
   * the popover when the user clicks the ⓘ. Keep it under ~250
   * characters; longer than that and the popover starts to lose its
   * "tap to peek" affordance.
   */
  reason?: string | null;
}

export function DisabledHint({ reason }: DisabledHintProps) {
  if (!reason) return null;
  return (
    <InfoTip
      title="Why this is disabled"
      side="bottom"
      className="mt-1 text-yellow-300"
      ariaLabel="Why is this button disabled?"
    >
      <p>{reason}</p>
    </InfoTip>
  );
}
