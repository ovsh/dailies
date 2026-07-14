interface AudioGlyphProps {
  size?: number;
  className?: string;
}

/** Minimal microphone glyph, kept in the same line style as the media-status glyphs. */
export function AudioGlyph({ size = 16, className }: AudioGlyphProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
      <path d="M8.5 21h7" />
    </svg>
  );
}
