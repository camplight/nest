const paths = {
  branding: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 0-10z M7 8h.01 M11 6h.01 M16 7h.01 M5 12h.01',
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  agents: 'M12 3v3 M9 3h6 M5 7h14v13H5z M2 11v5 M22 11v5 M9 11v2 M15 11v2 M9 17h6',
  runners: 'M4 3h16v7H4z M4 14h16v7H4z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  teams: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21v-2a7 7 0 0 1 14 0v2 M17 4a4 4 0 0 1 0 8 M19 15a6 6 0 0 1 3 6',
  channels: 'M5 9h16 M3 15h16 M11 3 7 21 M17 3l-4 18',
  chat: 'M21 11a9 9 0 0 1-9 9H8l-5 2 1-6a9 9 0 1 1 17-5 M8 10h8 M8 14h5',
  events: 'M3 12h4l3-8 4 16 3-8h4',
  processes: 'M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4',
  skills: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z',
  secrets: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  'api-keys': 'M10 14a6 6 0 1 1 4-4L4 20H2v-4z M16 7h.01',
  'agent-invites': 'M3 5h14v14H3z M3 5l7 6 7-6 M20 9v8 M16 13h8',
  humans: 'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10 M3 22v-2a9 6 0 0 1 18 0v2',
  profile: 'M3 3h18v18H3z M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M7 18a5 4 0 0 1 10 0',
  processed: 'M22 11v1a10 10 0 1 1-6-9 M8 11l4 4L22 5',
  failed: 'M12 3 2 21h20z M12 9v5 M12 17h.01',
  pending: 'M5 3h14 M5 21h14 M7 3v4l10 10v4 M17 3v4L7 17v4',
  scheduled: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 2'
};

export type IconName = keyof typeof paths;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`nest-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={paths[name]} />
    </svg>
  );
}
