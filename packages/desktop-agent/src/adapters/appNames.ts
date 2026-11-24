/**
 * Maps executable names to the app names people recognise, and detects meetings.
 * Pure functions, shared by the Windows helper wrapper and the polling collectors.
 */

const FRIENDLY_NAMES: Record<string, string> = {
  excel: 'Microsoft Excel',
  winword: 'Microsoft Word',
  powerpnt: 'Microsoft PowerPoint',
  outlook: 'Outlook',
  olk: 'Outlook',
  onenote: 'OneNote',
  'ms-teams': 'Microsoft Teams',
  teams: 'Microsoft Teams',
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  acrord32: 'Adobe Acrobat',
  acrobat: 'Adobe Acrobat',
  foxitpdfreader: 'Foxit PDF Reader',
  sumatrapdf: 'SumatraPDF',
  qbw32: 'QuickBooks',
  qbw: 'QuickBooks',
  zoom: 'Zoom',
  slack: 'Slack',
  explorer: 'File Explorer',
  code: 'Visual Studio Code',
};

const MEETING_APPS = /zoom|teams|webex|slack|meet|skype|gotomeeting|bluejeans/i;
const MEETING_TITLE = /\b(meeting|call|huddle|webinar)\b/i;

export function friendlyAppName(exe: string): string {
  const key = exe.trim().toLowerCase();
  return FRIENDLY_NAMES[key] ?? (exe.trim() || 'Windows App');
}

/**
 * A meeting is a call window in a meeting app, or any app holding the microphone or camera.
 * Teams chat or a Slack channel is not a meeting, so the title must also say so.
 */
export function detectMeeting(app: string, title: string, mediaInUse: boolean): boolean {
  if (mediaInUse) return true;
  return MEETING_APPS.test(app) && MEETING_TITLE.test(title);
}
