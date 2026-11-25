/**
 * Maps executable names to the app names people recognise, and detects meetings.
 * Pure functions, shared by the Windows helper wrapper and the polling collectors.
 */

const FRIENDLY_NAMES: Record<string, string> = {
  excel: 'Microsoft Excel',
  'microsoft excel': 'Microsoft Excel',
  winword: 'Microsoft Word',
  'microsoft word': 'Microsoft Word',
  powerpnt: 'Microsoft PowerPoint',
  'microsoft powerpoint': 'Microsoft PowerPoint',
  outlook: 'Outlook',
  'microsoft outlook': 'Outlook',
  olk: 'Outlook',
  onenote: 'OneNote',
  'microsoft onenote': 'OneNote',
  'ms-teams': 'Microsoft Teams',
  'microsoft teams': 'Microsoft Teams',
  teams: 'Microsoft Teams',
  chrome: 'Google Chrome',
  'google chrome': 'Google Chrome',
  'google-chrome': 'Google Chrome',
  chromium: 'Chromium',
  'chromium-browser': 'Chromium',
  msedge: 'Microsoft Edge',
  'microsoft-edge': 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  firefox: 'Firefox',
  'firefox-esr': 'Firefox',
  brave: 'Brave',
  'brave-browser': 'Brave',
  safari: 'Safari',
  acrord32: 'Adobe Acrobat',
  acrobat: 'Adobe Acrobat',
  'adobe acrobat': 'Adobe Acrobat',
  foxitpdfreader: 'Foxit PDF Reader',
  sumatrapdf: 'SumatraPDF',
  preview: 'Preview',
  evince: 'Document Viewer',
  okular: 'Okular',
  qbw32: 'QuickBooks',
  qbw: 'QuickBooks',
  quickbooks: 'QuickBooks',
  zoom: 'Zoom',
  'zoom.us': 'Zoom',
  slack: 'Slack',
  thunderbird: 'Thunderbird',
  mail: 'Mail',
  notes: 'Notes',
  finder: 'Finder',
  explorer: 'File Explorer',
  nautilus: 'Files',
  'org.gnome.nautilus': 'Files',
  dolphin: 'Dolphin',
  thunar: 'Thunar',
  'libreoffice-calc': 'LibreOffice Calc',
  'libreoffice-writer': 'LibreOffice Writer',
  'libreoffice-impress': 'LibreOffice Impress',
  'soffice.bin': 'LibreOffice',
  libreoffice: 'LibreOffice',
  code: 'Visual Studio Code',
  'code-oss': 'Visual Studio Code',
  codium: 'VSCodium',
  terminal: 'Terminal',
  'gnome-terminal-server': 'Terminal',
  iterm2: 'iTerm2',
  konsole: 'Konsole',
  alacritty: 'Alacritty',
  kitty: 'Kitty',
  'wezterm-gui': 'WezTerm',
  ghostty: 'Ghostty',
};

const MEETING_APPS = /zoom|teams|webex|slack|meet|skype|gotomeeting|bluejeans/i;
const MEETING_TITLE = /\b(meeting|call|huddle|webinar)\b/i;

export function friendlyAppName(exe: string, fallback = 'Desktop App'): string {
  const cleaned = exe.trim().replace(/\.(exe|app)$/i, '');
  const key = cleaned.toLowerCase();
  return FRIENDLY_NAMES[key] ?? (cleaned || fallback);
}

/**
 * A meeting is a call window in a meeting app, or any app holding the microphone or camera.
 * Teams chat or a Slack channel is not a meeting, so the title must also say so.
 */
export function detectMeeting(app: string, title: string, mediaInUse: boolean): boolean {
  if (mediaInUse) return true;
  return MEETING_APPS.test(app) && MEETING_TITLE.test(title);
}
