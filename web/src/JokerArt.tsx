import { useId } from "react";

// Original, scalable harlequin artwork. The same engraving becomes monochrome for the small joker.
export function JokerArt({ color }: { color: boolean }) {
  const id = useId().replace(/:/g, "");
  const ink = "#282529";
  const red = color ? "#bf2546" : "#424247";
  const blue = color ? "#265d91" : "#85858b";
  const gold = color ? "#e7b743" : "#c5c4c1";
  const cream = "#fff9e9";
  return (
    <svg className={`joker-art ${color ? "color-joker" : "mono-joker"}`} viewBox="0 0 100 150" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={`${id}-diamonds`} width="20" height="24" patternUnits="userSpaceOnUse">
          <rect width="20" height="24" fill={gold} />
          <path d="M10 0 20 12 10 24 0 12Z" fill={red} />
          <path d="M0 0 10 0 0 12ZM20 12 20 24 10 24Z" fill={blue} />
        </pattern>
      </defs>
      <g stroke={ink} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
        {/* Floating carnival stars and ribbon. */}
        <path d="m82 16 2 5 5 1-4 3 1 5-4-3-5 2 2-5-3-4 5 1Z" fill={gold} />
        <path d="m14 93 2 4 5 1-4 3 1 4-4-2-4 2 1-4-3-3 5-1Z" fill={red} />
        <path d="M83 98q12 5 4 10t-2 10" fill="none" stroke={blue} strokeWidth="2.5" />
        <path d="M14 26q-8 8 0 10t-2 11" fill="none" stroke={blue} strokeWidth="2" />
        {/* Dancing stockings and curved shoes. */}
        <path d="m39 92-5 21 13 13 7-6-11-14 10-11Z" fill={blue} />
        <path d="m54 94 9 16-4 22 10 1 6-26-9-16Z" fill={red} />
        <path d="m35 112 6-2m-1 11 8-5m15 2 9 2m-11 5 10 2" stroke={cream} strokeWidth="3" />
        <path d="m47 122-7 9q-6 8-17 0 0 16 15 13l19-15Z" fill={red} />
        <path d="m60 129-3 11q19 10 25-9-10 9-15-1Z" fill={blue} />
        <path d="M29 141q7 4 15-1m17 0q6 3 11-1" fill="none" stroke={gold} />
        {/* Coat, flared tails and diamond sleeves. */}
        <path d="m34 65-8 31 15-5 9 12 8-10 15 7-9-35Z" fill={`url(#${id}-diamonds)`} />
        <path d="M33 66 22 75 13 62 7 67l13 21 16-10m27-12 13-9 7-18 7 3-6 23-17 14" fill={`url(#${id}-diamonds)`} />
        <path d="m10 61-6 4 5 8 8-6Zm72-22 7 4 4-7-8-4Z" fill={cream} />
        {/* Expressive white gloves. */}
        <path d="M7 65 2 59q-2-4 1-4l5 4-3-9q0-4 3-2l4 8 1-9q2-3 3 1v12l3-3q4-1 3 2l-7 9Z" fill={cream} />
        <path d="m85 34-3-7q-1-4 2-3l4 6-1-12q1-4 3-1l2 12 3-7q3-2 3 1l-4 13-5 3Z" fill={cream} />
        <path d="M88 44 94 81" stroke={gold} strokeWidth="2.4" />
        <path d="m92 76-3 5 4 6 5-4-1-6Z" fill={red} />
        {/* Curly hair, face and circus smile. */}
        <path d="M33 36q-8-2-7 5-6 3-1 7-4 5 3 8-2 7 6 7l30-4q7-2 3-8 7-4 2-9 4-6-4-7Z" fill={gold} />
        <path d="M33 35q2 24 17 26 17-3 15-26Z" fill={cream} />
        <path d="m38 40 7-3m10 0 7 3" fill="none" strokeWidth="2" />
        <path d="m39 43 3-3 4 4m8 0 4-4 3 3" fill="none" />
        <circle cx="50" cy="45" r="3.5" fill={red} />
        <path d="M39 49q12 16 23-1-13 5-23 1Z" fill={red} />
        <path d="m44 51 13-1-3 5-6 1Z" fill={cream} strokeWidth=".7" />
        <circle cx="36" cy="47" r="2" fill={red} stroke="none" />
        <circle cx="63" cy="46" r="2" fill={red} stroke="none" />
        {/* Pleated ruff and two buttons. */}
        <path d="m31 56 7 2 4 4 8-2 7 2 7-6 6 3-6 10-9-2-6 5-8-5-10 1Z" fill={cream} />
        <path d="m37 59 3 8m7-6 2 10m9-9-3 5m10-9-3 9" fill="none" />
        <circle cx="50" cy="78" r="2.4" fill={cream} />
        <circle cx="51" cy="89" r="2.4" fill={cream} />
        {/* Three-point jester cap with bells. */}
        <path d="M31 34Q22 18 20 15q13-2 24 13Q41 9 51 4q11 9 9 24 8-16 20-13-9 7-12 20Z" fill={red} />
        <path d="M44 28Q41 9 51 4q11 9 9 24l-9 7Z" fill={blue} />
        <path d="M60 28q8-16 20-13-9 7-12 20l-9-2Z" fill={gold} />
        <path d="M31 33q18-6 36 1l-1 5q-17-6-34 0Z" fill={ink} />
        <path d="M36 34q13-2 25 1" stroke={gold} fill="none" strokeWidth="1.5" />
        <circle cx="20" cy="14" r="3" fill={gold} />
        <circle cx="51" cy="4" r="3" fill={gold} />
        <circle cx="80" cy="14" r="3" fill={red} />
      </g>
    </svg>
  );
}
