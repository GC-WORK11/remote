// Inline SVG icon set — geometric, 1.6px stroke, inherits currentColor.
import { JSX } from "solid-js";

interface P {
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
}
const svg = (p: P, children: JSX.Element) => (
  <svg
    width={p.size ?? 18}
    height={p.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    style={p.style}
  >
    {children}
  </svg>
);

export const I = {
  menu: (p: P) => svg(p, <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h10" /></>),
  plus: (p: P) => svg(p, <><path d="M12 5v14" /><path d="M5 12h14" /></>),
  send: (p: P) => svg(p, <path d="M4.5 11.5 19 4.8c.9-.4 1.7.5 1.3 1.4l-6.2 14.3c-.4.9-1.7.8-2-.2l-1.7-5a2 2 0 0 0-1.3-1.3l-4.9-1.6c-.9-.3-.9-1.6.1-1.9Z" />),
  stop: (p: P) => svg(p, <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />),
  check: (p: P) => svg(p, <path d="m5 12.5 4.5 4.5L19 7.5" />),
  x: (p: P) => svg(p, <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>),
  chevR: (p: P) => svg(p, <path d="m9 6 6 6-6 6" />),
  chevL: (p: P) => svg(p, <path d="m15 6-6 6 6 6" />),
  chevD: (p: P) => svg(p, <path d="m6 9 6 6 6-6" />),
  arrowR: (p: P) => svg(p, <><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></>),
  attach: (p: P) => svg(p, <path d="m8.5 12.5 6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l7.5-7.5" />),
  image: (p: P) => svg(p, <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m5 18 5-5 3 3 3.5-3.5L20.5 17" /></>),
  mic: (p: P) => svg(p, <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v2.5" /></>),
  folder: (p: P) => svg(p, <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />),
  folderOpen: (p: P) => svg(p, <path d="M3.5 8a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v1H8.5a3 3 0 0 0-2.8 1.9L3.5 19Zm0 0v9.4A2 2 0 0 0 5.5 19h13a2 2 0 0 0 2-1.7l1-4.8H8.6a3 3 0 0 0-2.9 2.2Z" />),
  file: (p: P) => svg(p, <><path d="M6.5 3.5h7L19 9v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1.5-1.5Z" /><path d="M13.5 3.5V9H19" /></>),
  terminal: (p: P) => svg(p, <><path d="m5 7 5 5-5 5" /><path d="M12 17h7" /></>),
  screen: (p: P) => svg(p, <><rect x="3" y="4.5" width="18" height="12.5" rx="2.5" /><path d="M9 20.5h6" /><path d="M12 17v3.5" /></>),
  git: (p: P) => svg(p, <><circle cx="6.5" cy="6" r="2.2" /><circle cx="6.5" cy="18" r="2.2" /><circle cx="17.5" cy="9" r="2.2" /><path d="M6.5 8.2v7.6" /><path d="M17.5 11.2c0 3.4-2.8 4.6-6 4.8" /></>),
  pr: (p: P) => svg(p, <><circle cx="6.5" cy="6" r="2.2" /><circle cx="6.5" cy="18" r="2.2" /><circle cx="17.5" cy="18" r="2.2" /><path d="M6.5 8.2v7.6" /><path d="M17.5 15.8V9.5a3 3 0 0 0-3-3h-2" /></>),
  repo: (p: P) => svg(p, <><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5Z" /><path d="M5 19.5V4.5" /><path d="M19 18v3H6.5" /><path d="M9 7h6" /></>),
  globe: (p: P) => svg(p, <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c-4.7 4.6-4.7 12.4 0 17 4.7-4.6 4.7-12.4 0-17Z" /></>),
  star: (p: P) => svg(p, <path d="m12 4 2.3 4.9 5.2.6-3.9 3.6 1.1 5.2L12 15.7l-4.7 2.6 1.1-5.2-3.9-3.6 5.2-.6Z" />),
  pin: (p: P) => svg(p, <path d="m14.5 4.5 5 5-3 .7-2.5 2.5-.3 4.8-2-2-4.4 4.4 4.4-4.4-2-2 4.8-.3 2.5-2.5Z" />),
  pinOff: (p: P) => svg(p, <><path d="m14.5 4.5 5 5-3 .7-2.5 2.5-.3 4.8-2-2" /><path d="M4 4l16 16" /></>),
  trash: (p: P) => svg(p, <><path d="M5 7h14" /><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2" /><path d="M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7" /><path d="M10 11v5" /><path d="M14 11v5" /></>),
  eyeOff: (p: P) => svg(p, <><path d="M4 4l16 16" /><path d="M9.9 5.2A9.4 9.4 0 0 1 12 5c5.5 0 9.5 4.5 10.5 7a13.6 13.6 0 0 1-3 4.1M6.1 6.7A13.3 13.3 0 0 0 1.5 12c1 2.5 5 7 10.5 7a9 9 0 0 0 4-.9" /><path d="M10 10a3 3 0 0 0 4.2 4.2" /></>),
  eye: (p: P) => svg(p, <><path d="M1.5 12C2.5 9.5 7 5 12 5s9.5 4.5 10.5 7c-1 2.5-5.5 7-10.5 7S2.5 14.5 1.5 12Z" /><circle cx="12" cy="12" r="3" /></>),
  movie: (p: P) => svg(p, <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 9.5h18M7.5 5v4.5M16.5 5v4.5" /></>),
  logout: (p: P) => svg(p, <><path d="M14 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H14" /><path d="m17 8 4 4-4 4M9 12h12" /></>),
  battery: (p: P) => svg(p, <><rect x="2.5" y="8" width="17" height="8" rx="2" /><path d="M21.5 11v2M5.5 11v2M8.5 11v2" /></>),
  pencil: (p: P) => svg(p, <path d="m5 19 .8-3.2L16.5 5a1.9 1.9 0 0 1 2.7 2.7L8.4 18.4Z" />),
  restart: (p: P) => svg(p, <><path d="M4.5 9a8 8 0 1 1-.5 6" /><path d="M4.5 4v5h5" /></>),
  continue: (p: P) => svg(p, <path d="M5 4.5a1 1 0 0 1 1.5-.8l12 7a1 1 0 0 1 0 1.7l-12 7A1 1 0 0 1 5 18.6Z" fill="currentColor" stroke="none" />),
  download: (p: P) => svg(p, <><path d="M12 4v10.5" /><path d="m7 10.5 5 5 5-5" /><path d="M4.5 19.5h15" /></>),
  clock: (p: P) => svg(p, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  zap: (p: P) => svg(p, <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z" />),
  settings: (p: P) => svg(p, <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.7a7 7 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.1 1.2L10 21h4l.5-2.7a7 7 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" /></>),
  copy: (p: P) => svg(p, <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 3h9A1.5 1.5 0 0 1 15.5 4.5V5" /></>),
  mark: (p: P) => svg(p, <><path d="M4.5 4.5h15v15h-15Z" /><path d="m8 12.5 2.5 2.5L16.5 9" /></>),
  layers: (p: P) => svg(p, <><path d="m12 3.5 8.5 4.5L12 12.5 3.5 8Z" /><path d="m4.5 12.5 7.5 4 7.5-4" /><path d="m4.5 16.5 7.5 4 7.5-4" /></>),
  search: (p: P) => svg(p, <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>),
  arrowUp: (p: P) => svg(p, <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>),
  home: (p: P) => svg(p, <><path d="M4 11.5 12 4l8 7.5" /><path d="M6.5 10v9h11v-9" /></>),
  inbox: (p: P) => svg(p, <><path d="M4 13.5 6.5 5h11L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18Z" /><path d="M4 13.5h5.5a2.5 2.5 0 0 0 5 0H20" /></>),
  grid: (p: P) => svg(p, <><rect x="4" y="4" width="7" height="7" rx="1.8" /><rect x="13" y="4" width="7" height="7" rx="1.8" /><rect x="4" y="13" width="7" height="7" rx="1.8" /><rect x="13" y="13" width="7" height="7" rx="1.8" /></>),
  moon: (p: P) => svg(p, <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />),
  sun: (p: P) => svg(p, <><circle cx="12" cy="12" r="4" /><path d="M12 2.5V5M12 19v2.5M2.5 12H5m14 0h2.5M5.3 5.3 7 7m10 10 1.7 1.7m0-13.4L17 7M7 17l-1.7 1.7" /></>),
  brain: (p: P) => svg(p, <><path d="M9.5 4A2.7 2.7 0 0 0 6.8 6.7c-1.7.4-2.8 1.9-2.8 3.7a3.7 3.7 0 0 0 1.3 2.8 3.8 3.8 0 0 0 .7 4.6A3 3 0 0 0 9.5 20c1.3 0 2.5-1 2.5-2.3V6.3C12 5 10.8 4 9.5 4Z" /><path d="M14.5 4a2.7 2.7 0 0 1 2.7 2.7c1.7.4 2.8 1.9 2.8 3.7a3.7 3.7 0 0 1-1.3 2.8 3.8 3.8 0 0 1-.7 4.6A3 3 0 0 1 14.5 20c-1.3 0-2.5-1-2.5-2.3V6.3C12 5 13.2 4 14.5 4Z" /></>),
  link: (p: P) => svg(p, <><path d="M10 14a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.6-5.6L12 7" /><path d="M14 10a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.6 5.6L12 17" /></>),
  shield: (p: P) => svg(p, <path d="M12 3.5 5 6v5c0 4.6 3 7.9 7 9.5 4-1.6 7-4.9 7-9.5V6Z" />),
  dot: (p: P) => svg(p, <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />),
  sparkles: (p: P) => svg(p, <><path d="m12 4 1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7Z" fill="currentColor" stroke="none" /><path d="m18.5 15 .8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" fill="currentColor" stroke="none" /><path d="m5 15.5.6 1.5 1.5.6-1.5.6L5 19.7l-.6-1.5-1.5-.6 1.5-.6Z" fill="currentColor" stroke="none" /></>),
  computer: (p: P) => svg(p, <><rect x="3" y="4" width="18" height="12" rx="2.5" /><path d="M8.5 20.5h7M12 16.5v4" /></>),
  branch: (p: P) => svg(p, <><circle cx="7" cy="6" r="2.2" /><circle cx="7" cy="18" r="2.2" /><circle cx="17" cy="8" r="2.2" /><path d="M7 8.2v7.6M17 10.2c0 4-4 4.6-7.5 4.8" /></>),
  warning: (p: P) => svg(p, <><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4" /><circle cx="12" cy="16.8" r=".4" fill="currentColor" /></>),
  key: (p: P) => svg(p, <><circle cx="8" cy="15.5" r="4" /><path d="m11 12.5 8.5-8.5" /><path d="m16.5 7 2.5 2.5M14 9.5l2 2" /></>),
  users: (p: P) => svg(p, <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" /><circle cx="17" cy="9.5" r="2.6" /><path d="M15.6 14.9c2.5.2 4.3 1.9 4.9 4.6" /></>),
  calendar: (p: P) => svg(p, <><rect x="4" y="5.5" width="16" height="15" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>),
  bell: (p: P) => svg(p, <><path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10Z" /><path d="M10 18.5a2 2 0 0 0 4 0" /></>),
  gauge: (p: P) => svg(p, <><path d="M4.5 18a8.5 8.5 0 1 1 15 0" /><path d="m12 14 3.5-4.5" /><circle cx="12" cy="14" r="1.3" fill="currentColor" /></>),
  play: (p: P) => svg(p, <path d="M7 5a1 1 0 0 1 1.5-.9l11 6.5a1 1 0 0 1 0 1.7l-11 6.5A1 1 0 0 1 7 17.9Z" fill="currentColor" stroke="none" />),
  pause: (p: P) => svg(p, <><rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /></>),
  camera: (p: P) => svg(p, <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 4.5h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18Z" /><circle cx="12" cy="13" r="3.5" /></>),
  rec: (p: P) => svg(p, <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />),
  film: (p: P) => svg(p, <><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="M8 5v14M16 5v14M3.5 9.5H8m8 0h4.5M3.5 14.5H8m8 0h4.5" /></>),
  book: (p: P) => svg(p, <><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v16.5H6.5A1.5 1.5 0 0 0 5 21Z" /><path d="M5 19.5V4.5M9 7h6" /></>),
  cursor: (p: P) => svg(p, <path d="M5.5 3.5 19 11l-6.5 1.5L9 19Z" />),
  cursorFallback: (p: P) => svg(p, <path d="M5.5 3.5 19 11l-6.5 1.5L9 19Z" />),
};
export default I;
