import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasSeenTour, markTourSeen } from "./tourStorage.ts";

export interface TourStep {
  /** CSS selector for the real DOM element to spotlight, e.g. '[data-tour="nav-overview"]'. */
  target: string;
  title: string;
  body: string;
  placement?: "top" | "bottom" | "left" | "right";
  advance?: "click" | "continue";
  optional?: boolean;
  completion?: "target-disappears" | "route-changes";
}

interface GuidedTourProps {
  /** Unique storage key — the tour auto-plays once per browser per key. */
  tourKey: string;
  steps: TourStep[];
  /** Arms the tour; it starts (if not already seen) the moment this becomes true. */
  enabled: boolean;
  /** Starts the tour again when the value changes, even if it was already seen. */
  restartToken?: number;
  onActiveChange?: ((active: boolean) => void) | undefined;
}

const TARGET_POLL_MS = 150;
const TARGET_POLL_TIMEOUT_MS = 4000;
const OPTIONAL_TARGET_POLL_TIMEOUT_MS = 900;

function isUsableTarget(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.closest('[aria-hidden="true"]')) return false;
  const modal = document.querySelector<HTMLElement>(".modal-scrim");
  if (modal && !modal.contains(element)) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * Spotlight product tour: highlights a real UI element and shows a floating
 * callout next to it. Action steps follow the real element click, and every
 * callout also offers Continue as a non-mutating way to move on.
 */
export function GuidedTour({ tourKey, steps, enabled, restartToken, onActiveChange }: GuidedTourProps) {
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const targetElRef = useRef<Element | null>(null);
  const waitForTargetRef = useRef(false);
  const armedRef = useRef(false);
  const activeRef = useRef(false);
  const lastRestartTokenRef = useRef<number | undefined>(restartToken);
  const restartTokenRef = useRef<number | undefined>(restartToken);
  restartTokenRef.current = restartToken;

  const reportActive = useCallback((active: boolean) => {
    if (activeRef.current === active) return;
    activeRef.current = active;
    onActiveChange?.(active);
  }, [onActiveChange]);

  // Arm once when enabled becomes true, unless already seen. A changed token
  // explicitly replays the tour for the manual launcher.
  useEffect(() => {
    if (!enabled) return;
    if (restartToken !== undefined && restartToken !== lastRestartTokenRef.current) {
      lastRestartTokenRef.current = restartToken;
      armedRef.current = true;
      targetElRef.current = null;
      waitForTargetRef.current = false;
      setRect(null);
      setIndex(0);
      setStarted(true);
      reportActive(true);
      return;
    }
    lastRestartTokenRef.current = restartToken;
    if (armedRef.current) return;
    armedRef.current = true;
    if (hasSeenTour(tourKey)) return;
    waitForTargetRef.current = false;
    setStarted(true);
    setIndex(0);
    reportActive(true);
  }, [enabled, restartToken, tourKey, reportActive]);

  useEffect(() => {
    if (enabled || !started) return;
    setStarted(false);
    setRect(null);
    targetElRef.current = null;
    waitForTargetRef.current = false;
    reportActive(false);
  }, [enabled, started, reportActive]);

  const finish = useCallback(() => {
    markTourSeen(tourKey);
    setStarted(false);
    setRect(null);
    targetElRef.current = null;
    waitForTargetRef.current = false;
    reportActive(false);
  }, [reportActive, tourKey]);

  useEffect(() => () => reportActive(false), [reportActive]);

  // Locate the current step's target, polling briefly for elements that mount asynchronously.
  useEffect(() => {
    if (!started) return;
    const step = steps[index];
    if (!step) { finish(); return; }

    let cancelled = false;
    let elapsed = 0;
    const timeout = step.optional ? OPTIONAL_TARGET_POLL_TIMEOUT_MS : TARGET_POLL_TIMEOUT_MS;
    let retryTimer: number | undefined;
    targetElRef.current = null;
    setRect(null);
    const tryFind = () => {
      if (cancelled) return;
      const el = document.querySelector(step.target);
      if (el && isUsableTarget(el)) {
        targetElRef.current = el;
        waitForTargetRef.current = false;
        if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        setRect(el.getBoundingClientRect());
        return;
      }
      if (elapsed >= timeout) {
        // A target reached through Continue may belong to the next route.
        // Keep the advanced index alive until that page mounts it.
        if (waitForTargetRef.current) return;
        // Target never appeared (e.g. permission-gated nav item) — skip it.
        setIndex((i) => i + 1);
        return;
      }
      elapsed += TARGET_POLL_MS;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        tryFind();
      }, TARGET_POLL_MS);
    };
    const retryNow = () => {
      if (cancelled) return;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      tryFind();
    };
    const observer = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(retryNow);
    observer?.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.addEventListener("hashchange", retryNow);
    tryFind();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      observer?.disconnect();
      window.removeEventListener("hashchange", retryNow);
    };
  }, [started, index, steps, finish]);

  // Keep the highlight glued to its target as the page scrolls/resizes.
  useEffect(() => {
    if (!started) return;
    const update = () => {
      if (targetElRef.current) setRect(targetElRef.current.getBoundingClientRect());
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [index, started, steps]);

  // Advance when the user clicks the real, highlighted element.
  useEffect(() => {
    if (!started) return;
    const onClick = (event: MouseEvent) => {
      const el = targetElRef.current;
      if (!el || !(event.target instanceof Node) || !el.contains(event.target)) return;
      if (steps[index]?.advance === "continue") return;
      // Let the real click's own handler run first; advance on the next tick.
      const restartTokenAtClick = restartTokenRef.current;
      const currentStep = steps[index];
      const advance = () => {
        if (restartTokenRef.current === restartTokenAtClick) setIndex((i) => i + 1);
      };
      if (currentStep?.completion === "route-changes") {
        const hashAtClick = window.location.hash;
        let attempts = 0;
        const waitForRouteChange = () => {
          if (restartTokenRef.current !== restartTokenAtClick) return;
          if (window.location.hash !== hashAtClick) {
            advance();
            return;
          }
          attempts += 1;
          if (attempts < 30) setTimeout(waitForRouteChange, 100);
        };
        setTimeout(waitForRouteChange, 0);
        return;
      }
      if (currentStep?.completion !== "target-disappears") {
        setTimeout(advance, 0);
        return;
      }

      let attempts = 0;
      const waitForCompletion = () => {
        if (restartTokenRef.current !== restartTokenAtClick) return;
        if (!el.isConnected || !document.contains(el)) {
          advance();
          return;
        }
        attempts += 1;
        if (attempts < 30) setTimeout(waitForCompletion, 100);
      };
      setTimeout(waitForCompletion, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [started, index, steps]);

  useEffect(() => {
    if (started && index >= steps.length) finish();
  }, [started, index, steps.length, finish]);

  if (!started || !rect) return null;
  const step = steps[index];
  if (!step) return null;

  const placement = step.placement ?? "bottom";
  const padding = 6;
  const gap = 14;
  const bubbleMaxWidth = Math.max(0, Math.min(300, window.innerWidth - 24));
  const bubbleMaxLeft = Math.max(12, window.innerWidth - bubbleMaxWidth - 12);

  const highlightStyle: React.CSSProperties = {
    position: "fixed",
    top: rect.top - padding,
    left: rect.left - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
    borderRadius: "10px",
    boxShadow: "0 0 0 9999px rgba(8, 10, 16, 0.6)",
    outline: "2px solid var(--accent-strong)",
    outlineOffset: "2px",
    pointerEvents: "none",
    zIndex: 9998,
    transition: "all 0.25s var(--ease)",
  };

  const bubbleStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 9999,
    maxWidth: bubbleMaxWidth,
    display: "flex",
    flexDirection: "column",
  };
  if (placement === "bottom") {
    bubbleStyle.top = rect.bottom + gap;
    bubbleStyle.left = Math.min(Math.max(12, rect.left), bubbleMaxLeft);
  } else if (placement === "top") {
    bubbleStyle.bottom = window.innerHeight - rect.top + gap;
    bubbleStyle.left = Math.min(Math.max(12, rect.left), bubbleMaxLeft);
  } else if (placement === "right") {
    bubbleStyle.top = rect.top;
    bubbleStyle.left = Math.min(rect.right + gap, bubbleMaxLeft);
  } else {
    bubbleStyle.top = rect.top;
    bubbleStyle.left = Math.max(12, rect.left - gap - bubbleMaxWidth);
  }

  const showContinue = step.advance === "continue";

  return createPortal(
    <>
      <div style={highlightStyle} />
      <div className={`ve-tour-bubble arrow-${placement}`} style={bubbleStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
          <div style={{ fontWeight: 600, fontSize: "13.5px" }}>{step.title}</div>
          <button
            onClick={finish}
            aria-label="Skip tour"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: "15px", lineHeight: 1, padding: 0 }}
          >
            &times;
          </button>
        </div>
        <div style={{ fontSize: "12.5px", color: "var(--text-dim)", marginTop: "4px", lineHeight: 1.5 }}>
          {step.body}
        </div>
        {showContinue && (
          <button
            className="btn primary"
            onClick={() => {
              waitForTargetRef.current = true;
              setIndex((i) => i + 1);
            }}
            style={{ marginTop: "10px", alignSelf: "flex-end" }}
          >
            Continue
          </button>
        )}
      </div>
    </>,
    document.body
  );
}
