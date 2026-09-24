// Social / profile links the admin can fill in (Profile tab in /admin). Empty ones are hidden everywhere.
// icon: inner SVG for a 24x24 viewBox; fill: drawn filled (else stroked).
const bug = '<path d="M8 8a4 4 0 0 1 8 0v1H8z"/><rect x="7" y="9" width="10" height="11" rx="5"/><path d="M12 12v8M3 13h4M17 13h4M4 19l3-2M20 19l-3-2M4 7l3 2M20 7l-3 2"/>';
const flag = '<path d="M5 21V4h12l-2 4 2 4H5"/>';
export const SOCIAL_NETWORKS = [
  { key: 'github', label: 'GitHub', color: '#24292f', fill: true, icon: '<path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/>' },
  { key: 'medium', label: 'Medium', color: '#000000', fill: true, icon: '<path d="M6.9 6.5a6.1 6.1 0 1 0 0 11.1 6.1 6.1 0 0 0 0-11.1Zm8.6.3c-1.5 0-2.7 2.4-2.7 5.3s1.2 5.3 2.7 5.3 2.7-2.4 2.7-5.3-1.2-5.3-2.7-5.3Zm4.8.5c-.6 0-1 2.1-1 4.8s.4 4.8 1 4.8 1-2.1 1-4.8-.4-4.8-1-4.8Z"/>' },
  { key: 'instagram', label: 'Instagram', color: '#d6336c', fill: false, icon: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/>' },
  { key: 'linkedin', label: 'LinkedIn', color: '#0a66c2', fill: true, icon: '<path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05C20.6 8.65 21 11.2 21 14.5V21h-4v-5.8c0-1.4 0-3.2-1.95-3.2S12.8 13.5 12.8 15.1V21H9z"/>' },
  { key: 'youtube', label: 'YouTube', color: '#e62117', fill: true, icon: '<path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.8 15.3V8.7l5.7 3.3z"/>' },
  { key: 'hackerone', label: 'HackerOne', color: '#494649', fill: false, icon: bug },
  { key: 'bugcrowd', label: 'Bugcrowd', color: '#f26822', fill: false, icon: bug },
  { key: 'tryhackme', label: 'TryHackMe', color: '#212c42', fill: false, icon: flag },
  { key: 'hackthebox', label: 'Hack The Box', color: '#1a2332', fill: false, icon: flag },
  { key: 'website', label: 'Website', color: '#3a4254', fill: false, icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>' },
] as const;
