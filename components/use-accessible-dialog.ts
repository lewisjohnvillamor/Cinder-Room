"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useAccessibleDialog(active: boolean, onEscape?: () => void, dialogKey: unknown = active) {
  const escapeRef = useRef(onEscape);
  useEffect(() => { escapeRef.current = onEscape; }, [onEscape]);
  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const changedSiblings: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
    const frame = window.requestAnimationFrame(() => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[aria-modal='true']"));
      const dialog = dialogs.at(-1);
      const backdrop = dialog?.closest<HTMLElement>(".modal-backdrop, .meeting-backdrop");
      if (backdrop?.parentElement) {
        for (const sibling of Array.from(backdrop.parentElement.children)) {
          if (!(sibling instanceof HTMLElement) || sibling === backdrop) continue;
          changedSiblings.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") });
          sibling.inert = true;
          sibling.setAttribute("aria-hidden", "true");
        }
      }
      (dialog?.querySelector<HTMLElement>("[autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? dialog)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[aria-modal='true']"));
      const dialog = dialogs.at(-1);
      if (!dialog) return;
      if (event.key === "Escape" && escapeRef.current) {
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => !item.hidden && item.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      for (const { element, inert, ariaHidden } of changedSiblings) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", ariaHidden);
      }
      previousFocus?.focus();
    };
  }, [active, dialogKey]);
}
