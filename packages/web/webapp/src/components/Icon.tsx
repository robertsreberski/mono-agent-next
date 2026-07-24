import type { SVGProps } from "react";

export type IconName =
  | "agents"
  | "archive"
  | "attach"
  | "bell"
  | "check"
  | "chevron"
  | "chevron-right"
  | "close"
  | "copy"
  | "eye"
  | "eye-off"
  | "lock"
  | "menu"
  | "more"
  | "new"
  | "quote"
  | "refresh"
  | "restore"
  | "search"
  | "send"
  | "settings"
  | "spark"
  | "star"
  | "stop"
  | "threads"
  | "trash";

const paths: Record<IconName, React.ReactNode> = {
  agents: <><circle cx="12" cy="8" r="3" /><path d="M6.7 18.2c.8-3 2.6-4.6 5.3-4.6s4.5 1.6 5.3 4.6" /><path d="M6.1 7.7a2.4 2.4 0 0 0 0 4.7M17.9 7.7a2.4 2.4 0 0 1 0 4.7" /></>,
  archive: <><path d="M4 7h16" /><path d="M5 7l1 13h12l1-13" /><path d="M9 11h6" /><path d="M4 4h16v3H4z" /></>,
  attach: <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 1 1 5.7 5.7l-9.7 9.7a2 2 0 0 1-2.8-2.8l8.9-8.9" />,
  bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-2.5 7-2.5 8.5h17C20.5 16 18 16 18 9Z" /><path d="M10 20h4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  eye: <><path d="M3 12s3.4-5 9-5 9 5 9 5-3.4 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2.3" /></>,
  "eye-off": <path d="M4 4 20 20M9.6 7.3A10.6 10.6 0 0 1 12 7c5.6 0 9 5 9 5a15 15 0 0 1-2.1 2.5M6.1 9.1A14.5 14.5 0 0 0 3 12s3.4 5 9 5c.8 0 1.6-.1 2.3-.3" />,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  menu: <path d="M5 7h14M5 12h14M5 17h14" />,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  new: <path d="M12 5v14M5 12h14" />,
  quote: <><path d="M8 11H4a5 5 0 0 1 5-5v10a2 2 0 0 1-2 2H5" /><path d="M19 11h-4a5 5 0 0 1 5-5v10a2 2 0 0 1-2 2h-2" /></>,
  refresh: <><path d="M19 8a8 8 0 0 0-13.4-2L4 8" /><path d="M4 4v4h4M5 16a8 8 0 0 0 13.4 2L20 16" /><path d="M20 20v-4h-4" /></>,
  restore: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  spark: <path d="m12 2 1.5 5.2L19 9l-5.5 1.8L12 16l-1.5-5.2L5 9l5.5-1.8Z" />,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  threads: <><path d="M4 5h16v11H9l-5 4V5Z" /><path d="M8 9h8M8 12h5" /></>,
  trash: <><path d="M4 7h16" /><path d="m9 7 1-3h4l1 3" /><path d="m6 7 1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
};

export function Icon({
  name,
  size = 16,
  fill = "none",
  ...props
}: SVGProps<SVGSVGElement> & { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
