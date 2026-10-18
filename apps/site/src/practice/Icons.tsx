// Decorative icons of the practice-test screens (spec 027).
import type { ReactNode } from 'react';

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const FlagIcon = ({ size }: { size?: number }) => (
  <Icon size={size ?? 18}>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" />
  </Icon>
);
export const ChevronLeft = () => (
  <Icon>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);
export const ChevronRight = () => (
  <Icon>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);
export const ChevronDown = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const CheckIcon = ({ size }: { size?: number }) => (
  <Icon size={size ?? 18}>
    <path d="m5 12 5 5L20 7" />
  </Icon>
);
export const CrossIcon = ({ size }: { size?: number }) => (
  <Icon size={size ?? 18}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
