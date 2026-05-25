/**
 * Inline SVG icons (lucide-derived) as Preact components.
 * Each takes a `class` for sizing/colour, mirroring the previous `el()` SVGs.
 */
import type { JSX } from "preact";

function Svg({ class: cls, children }: { class: string; children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
    >
      {children}
    </svg>
  );
}

export const IconSearch = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);

export const IconLock = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);

export const IconKey = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <circle cx="8" cy="14" r="4" />
    <path d="M11 11l9-9" />
    <path d="M16 6l3 3" />
  </Svg>
);

export const IconCloud = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.7 1.5A4 4 0 0 0 6 18z" />
  </Svg>
);

export const IconList = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </Svg>
);

export const IconCopy = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
);

export const IconEye = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const IconPlus = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

export const IconPencil = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
);

export const IconTrash = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </Svg>
);

// lucide loader-2 — paired with Tailwind's `animate-spin`.
export const IconLoader = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </Svg>
);

// lucide check
export const IconCheck = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);

// lucide alert-circle
export const IconAlert = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </Svg>
);

export const IconGear = ({ class: cls }: { class: string }) => (
  <Svg class={cls}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
