export type ShellIconName =
  | "agents"
  | "archive"
  | "bell"
  | "chevron"
  | "close"
  | "eye"
  | "eye-off"
  | "lock"
  | "menu"
  | "new"
  | "refresh"
  | "restore"
  | "search"
  | "star"
  | "threads";

export function ShellIcon({
  name,
  size = 18,
  fill = "none",
}: {
  readonly name: ShellIconName;
  readonly size?: number;
  readonly fill?: string;
}) {
  const common = {
    fill,
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
  };
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      {...common}
    >
      {name === "agents" && (
        <>
          <circle cx="12" cy="8" r="3" />
          <path d="M6.7 18.2c.8-3 2.6-4.6 5.3-4.6s4.5 1.6 5.3 4.6" />
          <path d="M6.1 7.7a2.4 2.4 0 0 0 0 4.7M17.9 7.7a2.4 2.4 0 0 1 0 4.7" />
        </>
      )}
      {name === "archive" && (
        <>
          <rect x="4" y="5" width="16" height="4" rx="1" />
          <path d="M6 9v10h12V9M10 13h4" />
        </>
      )}
      {name === "bell" && (
        <>
          <path d="M18 9a6 6 0 0 0-12 0c0 7-2.5 7-2.5 8.5h17C20.5 16 18 16 18 9Z" />
          <path d="M10 20h4" />
        </>
      )}
      {name === "chevron" && <path d="m9 6 6 6-6 6" />}
      {name === "close" && <path d="m7 7 10 10M17 7 7 17" />}
      {name === "eye" && (
        <>
          <path d="M3 12s3.4-5 9-5 9 5 9 5-3.4 5-9 5-9-5-9-5Z" />
          <circle cx="12" cy="12" r="2.3" />
        </>
      )}
      {name === "eye-off" && (
        <>
          <path d="M4 4 20 20M9.6 7.3A10.6 10.6 0 0 1 12 7c5.6 0 9 5 9 5a15 15 0 0 1-2.1 2.5M6.1 9.1A14.5 14.5 0 0 0 3 12s3.4 5 9 5c.8 0 1.6-.1 2.3-.3" />
        </>
      )}
      {name === "lock" && (
        <>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </>
      )}
      {name === "menu" && <path d="M5 7h14M5 12h14M5 17h14" />}
      {name === "new" && <path d="M12 5v14M5 12h14" />}
      {name === "refresh" && (
        <>
          <path d="M19 8a8 8 0 0 0-13.4-2L4 8" />
          <path d="M4 4v4h4M5 16a8 8 0 0 0 13.4 2L20 16" />
          <path d="M20 20v-4h-4" />
        </>
      )}
      {name === "restore" && (
        <>
          <path d="M4 8V4m0 4h4M5.5 6.2A8 8 0 1 1 4.4 14" />
          <path d="M12 8v5l3 2" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 4 4" />
        </>
      )}
      {name === "star" && (
        <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
      )}
      {name === "threads" && (
        <>
          <path d="M4 5h16v11H9l-5 4V5Z" />
          <path d="M8 9h8M8 12h5" />
        </>
      )}
    </svg>
  );
}
