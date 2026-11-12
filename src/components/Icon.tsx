import type { ReactNode } from 'react';

const shapes: Record<string, ReactNode> = {
  home: <><path d="m3 11 9-7 9 7v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 20v-7h6v7" /></>,
  arrowRight: <path d="M4 12h15m-6-6 6 6-6 6" />,
  arrowLeft: <path d="M20 12H5m6-6-6 6 6 6" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  sliders: <><path d="M3 7h5m4 0h9M3 17h9m4 0h5" /><circle cx="10" cy="7" r="2" /><circle cx="14" cy="17" r="2" /></>,
  flow: <><rect x="3" y="3" width="7" height="7" rx="1.4" /><rect x="14" y="14" width="7" height="7" rx="1.4" /><path d="M6.5 10v5a2 2 0 0 0 2 2H14" /></>,
  text: <><path d="M4 6V4h16v2M12 4v16M9 20h6" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m3 17 5-5 4 4 3-3 6 6" /></>,
  video: <><rect x="2.5" y="5" width="14" height="14" rx="2" /><path d="m16.5 10 5-3v10l-5-3z" /></>,
  audio: <><path d="M9 18V6l11-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  group: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M8 6V4h10" /></>,
  cursor: <><path d="m5 3 14 8-6 2-3 6z" /></>,
  hand: <><path d="M8 13V6a1.5 1.5 0 0 1 3 0v5-1a1.5 1.5 0 0 1 3 0v1-1a1.5 1.5 0 0 1 3 0v2a1.5 1.5 0 0 1 3 0v4c0 3-2 5-5 5h-3c-2 0-3-1-4-2l-4-5a1.5 1.5 0 0 1 2-2l2 2" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  trash: <><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21h-4v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1L4.1 16.7l.1-.1A1.7 1.7 0 0 0 3 13.7H3v-3h.1A1.7 1.7 0 0 0 4.9 8l-.1-.1 2.8-2.8.1.1A1.7 1.7 0 0 0 10 4.1V4h4v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0 1.2 2.9H21v3h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3" /></>,
  upload: <><path d="M12 16V4m0 0 4 4m-4-4L8 8M4 17v3h16v-3" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  zoomIn: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M10.5 7.5v6M7.5 10.5h6" /></>,
  zoomOut: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6" /></>,
  fit: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>,
  close: <><path d="M6 6l12 12M18 6 6 18" /></>,
  link: <><path d="M10 13a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 4.3l-1.5 1.5" /><path d="M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.7l1.5-1.5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5" /></>,
  save: <><path d="M4 4h13l3 3v13H4zM8 4v6h8V4M8 20v-6h8v6" /></>,
  sparkles: <><path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  eye: <><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" /></>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16zM13 7l4 4" /></>,
  chevronDown: <><path d="m6 9 6 6 6-6" /></>,
  grid: <><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  file: <><path d="M6 3h8l4 4v14H6zM14 3v5h4" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2 6M20 5v6h-6" /></>,
  panelLeft: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  front: <><rect x="7" y="3" width="13" height="13" rx="2" /><path d="M4 8v11a2 2 0 0 0 2 2h10" /></>,
  back: <><rect x="4" y="8" width="13" height="13" rx="2" /><path d="M20 16V5a2 2 0 0 0-2-2H8" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  dot: <><circle cx="12" cy="12" r="3" /></>,
  script: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11M12 13h6M12 16h4" /></>,
  character: <><circle cx="12" cy="8" r="3.2" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></>,
  scene: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 16 5-4 4 3 3-2 6 5M16 8h.01" /></>,
  keyframe: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 5v14M16 5v14M10.5 9.5v5l4-2.5z" /></>,
  compare: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16M6 14l2-2 2 2M14 12l2 2 2-2" /></>,
  database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  wand: <><path d="m4 20 11-11M14 5l1.5 3L19 9.5 15.5 11 14 14l-1.5-3L9 9.5l3.5-1.5zM19 16l.7 1.3L21 18l-1.3.7L19 20l-.7-1.3L17 18l1.3-.7z" /></>,
};

interface IconProps {
  name: keyof typeof shapes | string;
  size?: number;
  className?: string;
}

export default function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {shapes[name] ?? shapes.dot}
    </svg>
  );
}
