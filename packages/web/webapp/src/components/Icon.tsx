// SPDX-License-Identifier: MIT
import type { SVGProps } from "react";

export type IconName =
  | "agent"
  | "archive"
  | "arrow-down"
  | "attach"
  | "bell"
  | "bell-off"
  | "check"
  | "chevron"
  | "close"
  | "command"
  | "copy"
  | "eye"
  | "eye-off"
  | "file"
  | "menu"
  | "more"
  | "new"
  | "quote"
  | "restore"
  | "search"
  | "send"
  | "settings"
  | "spark"
  | "star"
  | "stop"
  | "trash"
  | "threads";

const paths: Record<IconName, React.ReactNode> = {
  agent: (
    <>
      <rect x="5" y="7" width="14" height="12" rx="4" />
      <path d="M9 7V5m6 2V5M8.5 12h.01M15.5 12h.01M9 16c2 1 4 1 6 0" />
    </>
  ),
  archive: (
    <>
      <path d="M4 7h16M6 7v12h12V7M4 4h16v3H4z" />
      <path d="M9 11h6" />
    </>
  ),
  "arrow-down": <path d="m7 10 5 5 5-5" />,
  attach: <path d="m9 12 5.5-5.5a3 3 0 0 1 4.2 4.2l-7.5 7.5a5 5 0 0 1-7.1-7.1l7.6-7.6M8 15l7.5-7.5" />,
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  "bell-off": (
    <>
      <path d="m3 3 18 18M8.3 5.1A6 6 0 0 1 18 8c0 2.5.4 4.1 1 5.2M6 8c0 7-3 7-3 9h14M10 21h4" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  command: (
    <>
      <path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  "eye-off": (
    <>
      <path d="m3 3 18 18M10.6 6.2A9.4 9.4 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.1 2.8M6.2 6.2C3.9 7.8 2.5 12 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.7M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5M9 13h6M9 17h5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  new: <path d="M12 5v14M5 12h14" />,
  quote: (
    <>
      <path d="M7 10h4v8H5v-6c0-4 2-6 6-7" />
      <path d="M17 10h4v8h-6v-6c0-4 2-6 6-7" />
    </>
  ),
  restore: (
    <>
      <path d="M4 8v5h5" />
      <path d="M5.5 13a7 7 0 1 0 1-6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  send: <path d="m4 4 17 8-17 8 3-8zM7 12h14" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10M4 12h4M12 12h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
      <circle cx="10" cy="12" r="2" />
    </>
  ),
  spark: <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" />,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  threads: (
    <>
      <path d="M5 5h14v10H9l-4 4z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  ...props
}: { readonly name: IconName; readonly size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
