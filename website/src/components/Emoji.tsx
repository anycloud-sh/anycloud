import React from 'react';

type Props = {
  children?: string;
  className?: string;
  size?: number | string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean;
};

export default function Emoji({
  children,
  className,
  size = '1.15em',
  style,
  'aria-hidden': ariaHidden,
}: Props) {
  return (
    <span
      aria-hidden={ariaHidden}
      className={className}
      style={{
        display: 'inline-block',
        fontFamily:
          '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
        fontSize: typeof size === 'number' ? `${size}px` : size,
        lineHeight: 1,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
