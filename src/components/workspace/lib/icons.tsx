"use client";

// Inline SVG icons used by the three-column workspace shell. Paths
// transcribed from Tabler icons (CC-BY) so we don't pull in
// @tabler/icons-react just for the 10 glyphs the visual spec lists.
//
// All icons follow the same 24×24 viewBox + stroke-based rendering.
// Size + color come from currentColor + parent font-size. Pass
// `size` to override the default 14px.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 14, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 16 2-6 6-2-2 6z" />
    </Icon>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M9 9h1" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </Icon>
  );
}

export function PhotoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 8h.01" />
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m3 16 5-5c.928-.893 2.072-.893 3 0l5 5" />
      <path d="m14 14 1-1c.928-.893 2.072-.893 3 0l3 3" />
    </Icon>
  );
}

export function MovieIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 4v16" />
      <path d="M16 4v16" />
      <path d="M4 8h4" />
      <path d="M4 16h4" />
      <path d="M4 12h16" />
      <path d="M16 8h4" />
      <path d="M16 16h4" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  );
}

export function FilePlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </Icon>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h4l10.5-10.5a2.828 2.828 0 1 0-4-4L4 16v4z" />
      <path d="m13.5 6.5 4 4" />
    </Icon>
  );
}

