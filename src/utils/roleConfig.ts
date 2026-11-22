import { UserRole } from '../engine/types';
import { NavigationTab } from '../types';

export interface RolePolicyConfig {
  role: UserRole;
  label: string;
  shortLabel: string;
  description: string;
  defaultTab: NavigationTab;
  allowedTabs: { id: NavigationTab; label: string }[];
  showTimerBar: boolean;
  canQuickLog: boolean;
  canDrilldownTimeline: boolean;
}

export const ROLE_OPTIONS: { value: UserRole; label: string; shortLabel: string }[] = [
  { value: 'accountant', label: 'Accountant / Line Staff', shortLabel: 'Accountant' },
  { value: 'team_lead', label: 'Team Lead / Manager', shortLabel: 'Team Lead' },
  { value: 'line_manager', label: 'Line Manager', shortLabel: 'Line Mgr' },
  { value: 'executive', label: 'Executive / Owner', shortLabel: 'Executive' },
  { value: 'client', label: 'Client Portal', shortLabel: 'Client' },
  { value: 'admin_it', label: 'Admin / IT', shortLabel: 'Admin / IT' },
];

export const ROLE_POLICIES: Record<UserRole, RolePolicyConfig> = {
  accountant: {
    role: 'accountant',
    label: 'Accountant / Line Staff',
    shortLabel: 'Accountant',
    description: 'Own day timeline, tasks, auto-checklists, review tray, and shift handoff.',
    defaultTab: 'timeline',
    allowedTabs: [
      { id: 'timeline', label: 'Timeline' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'autotrack', label: 'Auto-Track' },
      { id: 'portal', label: 'Client Portal' },
      { id: 'report', label: 'Weekly Report' },
      { id: 'analytics', label: 'Analytics' },
    ],
    showTimerBar: true,
    canQuickLog: true,
    canDrilldownTimeline: false,
  },
  team_lead: {
    role: 'team_lead',
    label: 'Team Lead / Manager',
    shortLabel: 'Team Lead',
    description: 'Direct team capacity heatmap, deadline risks, handoffs, and audit-logged drill-down.',
    defaultTab: 'overview',
    allowedTabs: [
      { id: 'overview', label: 'Team Capacity' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'autotrack', label: 'Attribution' },
      { id: 'portal', label: 'Client Portal' },
      { id: 'report', label: 'Weekly Report' },
      { id: 'analytics', label: 'Analytics' },
    ],
    showTimerBar: true,
    canQuickLog: true,
    canDrilldownTimeline: true,
  },
  line_manager: {
    role: 'line_manager',
    label: 'Line Manager',
    shortLabel: 'Line Mgr',
    description: 'Multi-team workload heatmap, bottlenecks, deadline risk, and recurring forecast.',
    defaultTab: 'overview',
    allowedTabs: [
      { id: 'overview', label: 'Capacity & Risk' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'portal', label: 'Client Portal' },
      { id: 'analytics', label: 'Analytics' },
      { id: 'report', label: 'Weekly Report' },
      { id: 'autotrack', label: 'Attribution' },
    ],
    showTimerBar: false,
    canQuickLog: true,
    canDrilldownTimeline: true,
  },
  executive: {
    role: 'executive',
    label: 'Executive / Owner',
    shortLabel: 'Executive',
    description: 'Firm-wide utilization, client profitability, deadline risk, forecast, and data freshness.',
    defaultTab: 'overview',
    allowedTabs: [
      { id: 'overview', label: 'Executive Overview' },
      { id: 'report', label: 'Executive Report' },
      { id: 'analytics', label: 'Firm Analytics' },
    ],
    showTimerBar: false,
    canQuickLog: false,
    canDrilldownTimeline: false,
  },
  client: {
    role: 'client',
    label: 'Client Portal',
    shortLabel: 'Client',
    description: 'Confirmed milestones only, request intake, document uploads, approvals, and messages.',
    defaultTab: 'portal',
    allowedTabs: [{ id: 'portal', label: 'Client Portal' }],
    showTimerBar: false,
    canQuickLog: false,
    canDrilldownTimeline: false,
  },
  admin_it: {
    role: 'admin_it',
    label: 'Admin / IT',
    shortLabel: 'Admin / IT',
    description: 'Device sync health, role permissions, invitations, retention, audit logs, and policies.',
    defaultTab: 'admin',
    allowedTabs: [
      { id: 'admin', label: 'Admin & Fleet' },
      { id: 'autotrack', label: 'Engine & Agents' },
    ],
    showTimerBar: false,
    canQuickLog: false,
    canDrilldownTimeline: false,
  },
};

export function getRolePolicy(role: UserRole | null | undefined): RolePolicyConfig {
  return ROLE_POLICIES[role || 'accountant'] || ROLE_POLICIES.accountant;
}
