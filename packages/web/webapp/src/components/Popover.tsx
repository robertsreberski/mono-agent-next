import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const DISMISS_POPOVERS_EVENT = "mono-agent:dismiss-popovers";
const VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 8;
const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type PopoverPlacement =
  | "bottom-end"
  | "bottom-start"
  | "top-end"
  | "top-start";

interface PopoverContextValue {
  readonly openId: string | undefined;
  readonly setOpenId: (id: string | undefined) => void;
}

const PopoverContext = createContext<PopoverContextValue | undefined>(undefined);

export function PopoverProvider({ children }: { readonly children: ReactNode }) {
  const [openId, setOpenId] = useState<string>();

  useEffect(() => {
    if (openId === undefined) {
      delete document.body.dataset.consolePopover;
    } else {
      document.body.dataset.consolePopover = openId;
    }
    return () => {
      if (document.body.dataset.consolePopover === openId) {
        delete document.body.dataset.consolePopover;
      }
    };
  }, [openId]);

  useEffect(() => {
    const dismiss = () => setOpenId(undefined);
    window.addEventListener(DISMISS_POPOVERS_EVENT, dismiss);
    return () => window.removeEventListener(DISMISS_POPOVERS_EVENT, dismiss);
  }, []);

  return (
    <PopoverContext.Provider value={{ openId, setOpenId }}>
      {children}
    </PopoverContext.Provider>
  );
}

export function dismissPopovers(): void {
  window.dispatchEvent(new Event(DISMISS_POPOVERS_EVENT));
}

export function Popover({
  children,
  id,
  panelClassName,
  panelRole = "dialog",
  placement = "bottom-end",
  trigger,
  triggerClassName,
  triggerLabel,
  triggerTitle = triggerLabel,
}: {
  readonly children: ReactNode | ((close: () => void) => ReactNode);
  readonly id: string;
  readonly panelClassName?: string;
  readonly panelRole?: "dialog" | "menu";
  readonly placement?: PopoverPlacement;
  readonly trigger: ReactNode;
  readonly triggerClassName?: string;
  readonly triggerLabel: string;
  readonly triggerTitle?: string;
}) {
  const context = useContext(PopoverContext);
  if (context === undefined) {
    throw new Error("Popover must be rendered inside PopoverProvider.");
  }
  const { openId, setOpenId } = context;
  const open = openId === id;
  const reactId = useId();
  const panelId = `popover-${reactId.replaceAll(":", "")}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: "hidden",
  });

  const close = useCallback(() => setOpenId(undefined), [setOpenId]);
  const closeAndRestoreFocus = useCallback(() => {
    setOpenId(undefined);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [setOpenId]);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const firstControl = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (firstControl ?? panelRef.current)?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, closeAndRestoreFocus, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const triggerElement = triggerRef.current;
    const panelElement = panelRef.current;
    if (triggerElement === null || panelElement === null) return;

    let frame: number | undefined;
    const update = () => {
      const triggerRect = triggerElement.getBoundingClientRect();
      const panelRect = panelElement.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const availableAbove = triggerRect.top - POPOVER_GAP - VIEWPORT_MARGIN;
      const availableBelow =
        viewportHeight - triggerRect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
      const preferTop = placement.startsWith("top");
      const placeAbove = preferTop
        ? panelRect.height <= availableAbove || availableAbove > availableBelow
        : !(panelRect.height <= availableBelow || availableBelow >= availableAbove);
      const unclampedTop = placeAbove
        ? triggerRect.top - POPOVER_GAP - panelRect.height
        : triggerRect.bottom + POPOVER_GAP;
      const alignEnd = placement.endsWith("end");
      const unclampedLeft = alignEnd
        ? triggerRect.right - panelRect.width
        : triggerRect.left;
      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        viewportWidth - panelRect.width - VIEWPORT_MARGIN,
      );
      const maxTop = Math.max(
        VIEWPORT_MARGIN,
        viewportHeight - panelRect.height - VIEWPORT_MARGIN,
      );
      setPosition({
        left: Math.min(Math.max(unclampedLeft, VIEWPORT_MARGIN), maxLeft),
        maxHeight: Math.max(120, viewportHeight - (VIEWPORT_MARGIN * 2)),
        top: Math.min(Math.max(unclampedTop, VIEWPORT_MARGIN), maxTop),
        visibility: "visible",
      });
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    update();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(triggerElement);
    resizeObserver?.observe(panelElement);
    window.addEventListener("resize", scheduleUpdate);
    document.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      document.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [open, placement]);

  return (
    <span className="popover-anchor">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup={panelRole === "menu" ? "menu" : "dialog"}
        aria-label={triggerLabel}
        title={triggerTitle}
        onClick={() => setOpenId(open ? undefined : id)}
      >
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className={`popover-panel${panelClassName ? ` ${panelClassName}` : ""}`}
          role={panelRole}
          aria-label={triggerLabel}
          tabIndex={-1}
          style={position}
        >
          {typeof children === "function" ? children(closeAndRestoreFocus) : children}
        </div>,
        document.body,
      )}
    </span>
  );
}
