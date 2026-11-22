import {
  BoardSection,
  BoardSectionColor,
  Task,
  TaskStatus,
  WorkspaceBoard,
  WorkspaceHierarchy,
} from '../types';

export const SECTION_COLOR_META: Record<
  BoardSectionColor,
  { label: string; dot: string; headerText: string; topRule: string; softBg: string }
> = {
  indigo: {
    label: 'Indigo',
    dot: 'bg-indigo-600',
    headerText: 'text-indigo-700 dark:text-indigo-300',
    topRule: 'border-t-indigo-500',
    softBg: 'bg-indigo-50/70 dark:bg-indigo-950/30',
  },
  emerald: {
    label: 'Emerald',
    dot: 'bg-emerald-600',
    headerText: 'text-emerald-700 dark:text-emerald-300',
    topRule: 'border-t-emerald-500',
    softBg: 'bg-emerald-50/70 dark:bg-emerald-950/30',
  },
  amber: {
    label: 'Amber',
    dot: 'bg-amber-500',
    headerText: 'text-amber-700 dark:text-amber-300',
    topRule: 'border-t-amber-500',
    softBg: 'bg-amber-50/70 dark:bg-amber-950/30',
  },
  rose: {
    label: 'Rose',
    dot: 'bg-rose-600',
    headerText: 'text-rose-700 dark:text-rose-300',
    topRule: 'border-t-rose-500',
    softBg: 'bg-rose-50/70 dark:bg-rose-950/30',
  },
  sky: {
    label: 'Sky',
    dot: 'bg-sky-600',
    headerText: 'text-sky-700 dark:text-sky-300',
    topRule: 'border-t-sky-500',
    softBg: 'bg-sky-50/70 dark:bg-sky-950/30',
  },
  slate: {
    label: 'Slate',
    dot: 'bg-slate-500',
    headerText: 'text-slate-700 dark:text-slate-300',
    topRule: 'border-t-slate-400',
    softBg: 'bg-slate-100/80 dark:bg-slate-800/50',
  },
};

export function createStandardSections(prefix: string): BoardSection[] {
  return [
    {
      id: `${prefix}-sec-in-progress`,
      name: 'In Progress',
      description: 'Active workstreams currently being executed',
      color: 'indigo',
      mappedStatus: 'in_progress',
    },
    {
      id: `${prefix}-sec-blocked`,
      name: 'Blocked & At Risk',
      description: 'Tasks awaiting client records or dependency resolution',
      color: 'rose',
      mappedStatus: 'blocked',
    },
    {
      id: `${prefix}-sec-todo`,
      name: 'Queued / Todo',
      description: 'Planned deliverables scoped for upcoming shifts',
      color: 'slate',
      mappedStatus: 'todo',
    },
    {
      id: `${prefix}-sec-completed`,
      name: 'Completed',
      description: 'Reviewed and verified deliverables ready for sign-off',
      color: 'emerald',
      mappedStatus: 'completed',
    },
  ];
}

export function createAccountingCloseSections(prefix: string): BoardSection[] {
  return [
    {
      id: `${prefix}-sec-intake`,
      name: 'Client Intake',
      description: 'Awaiting bank feeds, trial balance, or payroll exports',
      color: 'slate',
      mappedStatus: 'todo',
    },
    {
      id: `${prefix}-sec-prep`,
      name: 'Workpaper Prep',
      description: 'Active journal entries and schedule tie-outs',
      color: 'indigo',
      mappedStatus: 'in_progress',
    },
    {
      id: `${prefix}-sec-review`,
      name: 'Manager Review',
      description: 'Pending senior or partner sign-off',
      color: 'amber',
      mappedStatus: 'in_progress',
    },
    {
      id: `${prefix}-sec-blocked`,
      name: 'Client Follow-Up',
      description: 'Blocked pending missing source documentation',
      color: 'rose',
      mappedStatus: 'blocked',
    },
    {
      id: `${prefix}-sec-done`,
      name: 'Filed & Published',
      description: 'Confirmed and delivered to client portal',
      color: 'emerald',
      mappedStatus: 'completed',
    },
  ];
}

export function createDefaultWorkspaceHierarchy(): WorkspaceHierarchy {
  const today = new Date().toISOString().slice(0, 10);
  return {
    spaces: [
      { id: 'spc-client-work', name: 'Client Engagements', color: 'indigo', collapsed: false },
      { id: 'spc-platform', name: 'Firm Operations', color: 'emerald', collapsed: false },
    ],
    folders: [
      { id: 'fld-close-cycles', spaceId: 'spc-client-work', name: 'Monthly Close & Reporting', collapsed: false },
    ],
    boards: [
      {
        id: 'brd-core-platform',
        spaceId: 'spc-client-work',
        folderId: 'fld-close-cycles',
        name: 'Core Platform',
        description: 'Primary engineering and close workflow deliverables',
        projectTag: 'Core Platform',
        sections: createStandardSections('core'),
        createdAt: today,
      },
      {
        id: 'brd-client-portal',
        spaceId: 'spc-client-work',
        folderId: 'fld-close-cycles',
        name: 'Client Portal',
        description: 'Client onboarding, portal milestones, and document intake',
        projectTag: 'Client Portal',
        sections: createAccountingCloseSections('portal'),
        createdAt: today,
      },
      {
        id: 'brd-analytics',
        spaceId: 'spc-client-work',
        folderId: null,
        name: 'Analytics Engine',
        description: 'Utilization telemetry, reconciliation rules, and risk scoring',
        projectTag: 'Analytics Engine',
        sections: createStandardSections('analytics'),
        createdAt: today,
      },
      {
        id: 'brd-internal-ops',
        spaceId: 'spc-platform',
        folderId: null,
        name: 'Internal Ops',
        description: 'Firm-wide compliance, shift scheduling, and tooling',
        projectTag: 'Internal Ops',
        sections: createStandardSections('ops'),
        createdAt: today,
      },
    ],
  };
}

export function resolveBoardForTask(
  task: Task,
  boards: WorkspaceBoard[]
): WorkspaceBoard | undefined {
  if (boards.length === 0) return undefined;
  if (task.boardId) {
    const direct = boards.find((b) => b.id === task.boardId);
    if (direct) return direct;
  }
  const byProject = boards.find(
    (b) =>
      b.projectTag.toLowerCase() === task.project.toLowerCase() ||
      b.name.toLowerCase() === task.project.toLowerCase()
  );
  return byProject || boards[0];
}

export function resolveSectionForTask(
  task: Task,
  board: WorkspaceBoard | undefined
): BoardSection | undefined {
  if (!board || board.sections.length === 0) return undefined;
  if (task.sectionId) {
    const direct = board.sections.find((s) => s.id === task.sectionId);
    if (direct) return direct;
  }
  const byStatus = board.sections.find((s) => s.mappedStatus === task.status);
  return byStatus || board.sections[0];
}

export function inferStatusLabel(status: TaskStatus): string {
  if (status === 'in_progress') return 'In Progress';
  if (status === 'blocked') return 'Blocked';
  if (status === 'completed') return 'Completed';
  return 'Todo';
}
