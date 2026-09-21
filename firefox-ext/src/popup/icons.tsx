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

/**
 * LocalPass brand mark, mirroring core/logo.svg. `small` renders the
 * heavier, flat variant (core/logo-small.svg) meant for ~16–32px.
 */
export const Logo = ({ class: cls, small }: { class: string; small?: boolean }) =>
  small ? (
    <svg viewBox="0 0 128 128" class={cls} aria-hidden="true">
      <rect width="128" height="128" rx="24" fill="#12203a" />
      <circle cx="64" cy="64" r="45" fill="none" stroke="#2c4064" stroke-width="12" />
      <circle
        cx="64" cy="64" r="45" fill="none" stroke="#dcb05a" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="203.58 282.74" transform="rotate(-90 64 64)"
      />
      <circle cx="19.80" cy="72.43" r="10" fill="#f4ecdc" />
      <path d="M44 38 V86 H84" fill="none" stroke="#f4ecdc" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
      <g stroke="#dcb05a" stroke-width="8" stroke-linecap="round">
        <line x1="69" y1="48" x2="69" y2="70" />
        <line x1="59.47" y1="53.5" x2="78.53" y2="64.5" />
        <line x1="78.53" y1="53.5" x2="59.47" y2="64.5" />
      </g>
    </svg>
  ) : (
    <svg viewBox="0 0 128 128" class={cls} aria-hidden="true">
      <defs>
        <linearGradient id="lp-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#13213a" />
          <stop offset="1" stop-color="#0b1526" />
        </linearGradient>
        <linearGradient id="lp-logo-brass" gradientUnits="userSpaceOnUse" x1="16" y1="16" x2="112" y2="112">
          <stop offset="0" stop-color="#ecc878" />
          <stop offset=".55" stop-color="#d6a94e" />
          <stop offset="1" stop-color="#b08433" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill="url(#lp-logo-bg)" />
      <circle cx="64" cy="64" r="48" fill="none" stroke="#23344f" stroke-width="8" />
      <circle
        cx="64" cy="64" r="48" fill="none" stroke="url(#lp-logo-brass)" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="217.15 301.59" transform="rotate(-90 64 64)"
      />
      <circle cx="16.85" cy="72.99" r="7.5" fill="#f4ecdc" />
      <path d="M46 40 V84 H82" fill="none" stroke="#f4ecdc" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" />
      <g stroke="url(#lp-logo-brass)" stroke-width="5.5" stroke-linecap="round">
        <line x1="68" y1="51" x2="68" y2="69" />
        <line x1="60.21" y1="55.5" x2="75.79" y2="64.5" />
        <line x1="75.79" y1="55.5" x2="60.21" y2="64.5" />
      </g>
    </svg>
  );
