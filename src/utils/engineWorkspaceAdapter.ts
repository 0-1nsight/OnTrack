import { AttributionRecord, EngineTask, WorkSession } from '../engine/types';
import { EngineSnapshot } from '../services/engineClient';
import {
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
  WorkCategory,
  WorkspaceBoard,
} from '../types';
import { inferAppCategory } from './workspaceConstants';

export function toLocalDateString(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function inferProjectForEngineTask(
  engTask: EngineTask,
  boards: WorkspaceBoard[]
): { project: string; boardId?: string; sectionId?: string } {
  const titleLower = engTask.title.toLowerCase();
  const clientLower = engTask.clientName.toLowerCase();

  const directBoard = boards.find(
    (b) =>
      b.projectTag.toLowerCase() === clientLower ||
      b.name.toLowerCase() === clientLower
  );
  if (directBoard) {
    const sec =
      directBoard.sections.find((s) => s.mappedStatus === engTask.status) ||
      directBoard.sections[0];
    return {
      project: directBoard.projectTag || directBoard.name,
      boardId: directBoard.id,
      sectionId: sec?.id,
    };
  }

  let project = 'Client Portal';
  if (titleLower.includes('audit') || titleLower.includes('payroll')) {
    project = 'Audit & Assurance';
  } else if (
    titleLower.includes('tax') ||
    titleLower.includes('close') ||
    titleLower.includes('reconcil') ||
    titleLower.includes('balance')
  ) {
    project = 'Tax & Close';
  } else if (titleLower.includes('internal') || clientLower.includes('internal')) {
    project = 'Internal Ops';
  } else if (titleLower.includes('analytics') || titleLower.includes('report')) {
    project = 'Analytics Engine';
  }

  const matchedBoard =
    boards.find(
      (b) =>
        b.projectTag.toLowerCase() === project.toLowerCase() ||
        b.name.toLowerCase() === project.toLowerCase()
    ) ||
    boards.find((b) => b.id === 'brd-client-portal') ||
    boards[0];

  const matchedSection =
    matchedBoard?.sections.find((s) => s.mappedStatus === engTask.status) ||
    matchedBoard?.sections[0];

  return {
    project,
    boardId: matchedBoard?.id,
    sectionId: matchedSection?.id,
  };
}

export function mapEngineTaskToWorkspaceTask(
  engTask: EngineTask,
  existingTask: Task | undefined = undefined,
  boards: WorkspaceBoard[] = []
): Task {
  const mappedPlacement = inferProjectForEngineTask(engTask, boards);
  const dueStr = engTask.dueDateUtc
    ? engTask.dueDateUtc.slice(0, 10)
    : toLocalDateString(new Date());

  const boardId = existingTask?.boardId || mappedPlacement.boardId;
  const board = boards.find((b) => b.id === boardId);
  let sectionId = existingTask?.sectionId;
  if (board) {
    const currentSec = board.sections.find((s) => s.id === sectionId);
    if (!currentSec || currentSec.mappedStatus !== engTask.status) {
      sectionId =
        board.sections.find((s) => s.mappedStatus === engTask.status)?.id ||
        board.sections[0]?.id;
    }
  } else {
    sectionId = mappedPlacement.sectionId;
  }

  const baseTags = new Set<string>(existingTask?.tags || []);
  if (engTask.clientName) {
    baseTags.add(
      engTask.clientName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    );
  }
  if (engTask.period) {
    baseTags.add(engTask.period.toLowerCase().replace(/\s+/g, '-'));
  }

  return {
    id: engTask.id,
    title: engTask.title,
    description:
      existingTask?.description ||
      `${engTask.clientName} · ${engTask.period} (${engTask.clientId})`,
    project: existingTask?.project || mappedPlacement.project,
    boardId,
    sectionId,
    status: engTask.status,
    priority: existingTask?.priority || 'high',
    category: existingTask?.category || 'billable',
    tags: Array.from(baseTags).filter(Boolean),
    estimatedMinutes: engTask.estimatedMinutes,
    blockerNote: existingTask?.blockerNote,
    subtasks: existingTask?.subtasks || [],
    createdAt:
      existingTask?.createdAt ||
      (engTask.updatedAtUtc ? engTask.updatedAtUtc.slice(0, 10) : dueStr),
    startDate: existingTask?.startDate || dueStr,
    dueDate: dueStr,
    completedAt:
      engTask.status === 'completed'
        ? existingTask?.completedAt || toLocalDateString(new Date())
        : undefined,
  };
}

function resolveSessionCategory(
  session: WorkSession,
  attr: AttributionRecord | undefined
): WorkCategory {
  if (session.isIdle) return 'admin';
  const activityLower = (session.entities.activityType || '').toLowerCase();
  const appLower = session.primaryApp.toLowerCase();
  if (appLower.includes('teams') || appLower.includes('slack') || appLower.includes('zoom')) {
    return 'collaborative';
  }
  if (attr?.clientId || session.entities.clientId || activityLower.includes('bill')) {
    return 'billable';
  }
  if (appLower.includes('code') || appLower.includes('terminal') || appLower.includes('excel')) {
    return 'deep_work';
  }
  return 'deep_work';
}

export function adaptEngineSessionsToTimeline(params: {
  sessions: WorkSession[];
  attributions: AttributionRecord[];
  includeAllAttributions?: boolean;
}): {
  timeBlocks: TimeBlock[];
  activitySegments: ActivitySegment[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
} {
  const { sessions, attributions, includeAllAttributions = false } = params;
  const attrMap = new Map(attributions.map((a) => [a.sessionId, a]));

  const timeBlocks: TimeBlock[] = [];
  const activitySegments: ActivitySegment[] = [];
  const appSegments: ApplicationUsageSegment[] = [];
  const documentSegments: DocumentUsageSegment[] = [];

  for (const s of sessions) {
    const startObj = new Date(s.startTimeUtc);
    const endObj = new Date(s.endTimeUtc);
    const dateStr = Number.isNaN(startObj.getTime())
      ? toLocalDateString(new Date())
      : toLocalDateString(startObj);

    const startMin = Math.max(
      0,
      Math.min(1425, startObj.getHours() * 60 + startObj.getMinutes())
    );
    const rawDur = Math.max(
      15,
      Math.round((endObj.getTime() - startObj.getTime()) / 60000) ||
        Math.round(s.durationSeconds / 60)
    );
    const endMin = Math.min(1440, startMin + rawDur);

    activitySegments.push({
      id: `seg-eng-sync-${s.id}`,
      date: dateStr,
      startTime: startMin,
      endTime: endMin,
      state: s.isIdle ? 'idle' : 'active',
      label: s.isIdle
        ? `Unreconciled Idle (${s.primaryTitle})`
        : `${s.primaryApp}: ${s.primaryTitle}`,
      reconciled: !s.isIdle,
    });

    if (s.isIdle) {
      continue;
    }

    appSegments.push({
      id: `app-eng-sync-${s.id}`,
      date: dateStr,
      startTime: startMin,
      endTime: endMin,
      appName: s.primaryApp,
      appCategory: inferAppCategory(s.primaryApp),
    });

    const attr = attrMap.get(s.id);
    documentSegments.push({
      id: `doc-eng-sync-${s.id}`,
      date: dateStr,
      startTime: startMin,
      endTime: endMin,
      appName: s.primaryApp,
      documentTitle: s.primaryTitle,
      domainOrPath: s.primaryUrl || s.primaryPath || s.primaryApp,
      linkedTaskId: attr?.taskId || null,
    });

    const shouldCreateBlock =
      includeAllAttributions ||
      (attr && (attr.status === 'confirmed' || attr.status === 'detected'));

    if (shouldCreateBlock) {
      const category = resolveSessionCategory(s, attr);
      timeBlocks.push({
        id: `blk-eng-sync-${s.id}`,
        taskId: attr?.taskId || null,
        title: attr?.taskTitle || s.primaryTitle,
        project:
          attr?.clientName ||
          s.entities.clientName ||
          (category === 'billable' ? 'Tax & Close' : 'Core Platform'),
        category,
        tags: [
          'auto-tracked',
          attr?.status || 'detected',
          s.osPlatform,
        ].filter(Boolean),
        date: dateStr,
        startTime: startMin,
        endTime: endMin,
        durationMinutes: endMin - startMin,
        source: 'reconciled',
        isBillable: category === 'billable',
        notes: `${attr?.reason || 'Captured by OnTrack Engine'} · ${s.primaryApp}`,
        appName: s.primaryApp,
        documentTitle: s.primaryTitle,
      });
    }
  }

  return { timeBlocks, activitySegments, appSegments, documentSegments };
}

function mergeByIdWithDedupe<T extends { id: string }>(
  localItems: T[],
  engineItems: T[],
  enginePrefix: string,
  isDuplicateOfEngine?: (localItem: T, engineItem: T) => boolean
): T[] {
  const preservedLocal = localItems.filter((item) => {
    if (item.id.startsWith(enginePrefix)) {
      return false;
    }
    if (isDuplicateOfEngine && engineItems.some((eng) => isDuplicateOfEngine(item, eng))) {
      return false;
    }
    return true;
  });
  return [...preservedLocal, ...engineItems];
}

export function adaptEngineSnapshotToWorkspace(params: {
  snapshot: EngineSnapshot;
  existingTasks: Task[];
  existingBlocks: TimeBlock[];
  existingActivity: ActivitySegment[];
  existingApps: ApplicationUsageSegment[];
  existingDocs: DocumentUsageSegment[];
  boards: WorkspaceBoard[];
  includeAllSessionBlocks?: boolean;
}): {
  tasks: Task[];
  timeBlocks: TimeBlock[];
  activitySegments: ActivitySegment[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
} {
  const {
    snapshot,
    existingTasks,
    existingBlocks,
    existingActivity,
    existingApps,
    existingDocs,
    boards,
    includeAllSessionBlocks = false,
  } = params;

  const existingTaskMap = new Map(existingTasks.map((t) => [t.id, t]));
  const engineTasksMapped = snapshot.tasks.map((et) =>
    mapEngineTaskToWorkspaceTask(et, existingTaskMap.get(et.id), boards)
  );
  const engineTaskIds = new Set(engineTasksMapped.map((t) => t.id));
  const localDraftTasks = existingTasks.filter(
    (t) =>
      !engineTaskIds.has(t.id) &&
      !t.id.startsWith('tsk-eng-') &&
      !t.id.startsWith('demo_tsk_')
  );

  const tasks = [...engineTasksMapped, ...localDraftTasks];

  const derived = adaptEngineSessionsToTimeline({
    sessions: snapshot.sessions,
    attributions: snapshot.attributions,
    includeAllAttributions: includeAllSessionBlocks,
  });

  const timeBlocks = mergeByIdWithDedupe(
    existingBlocks,
    derived.timeBlocks,
    'blk-eng-sync-',
    (localB, engB) =>
      localB.date === engB.date &&
      Math.abs(localB.startTime - engB.startTime) <= 2 &&
      localB.title.trim().toLowerCase() === engB.title.trim().toLowerCase()
  );

  const activitySegments = mergeByIdWithDedupe(
    existingActivity,
    derived.activitySegments,
    'seg-eng-sync-'
  );

  const appSegments = mergeByIdWithDedupe(
    existingApps,
    derived.appSegments,
    'app-eng-sync-',
    (localA, engA) =>
      localA.date === engA.date &&
      Math.abs(localA.startTime - engA.startTime) <= 2 &&
      localA.appName === engA.appName
  );

  const documentSegments = mergeByIdWithDedupe(
    existingDocs,
    derived.documentSegments,
    'doc-eng-sync-',
    (localD, engD) =>
      localD.date === engD.date &&
      Math.abs(localD.startTime - engD.startTime) <= 2 &&
      localD.documentTitle === engD.documentTitle
  );

  return {
    tasks,
    timeBlocks,
    activitySegments,
    appSegments,
    documentSegments,
  };
}

export function buildTimeBlockStartTimestampUtc(dateStr: string, startMinuteOfDay: number): string {
  const parts = dateStr.split('-').map(Number);
  if (parts.length === 3 && !parts.some(Number.isNaN)) {
    const [yyyy, mm, dd] = parts;
    const hh = Math.floor(startMinuteOfDay / 60);
    const min = startMinuteOfDay % 60;
    const dt = new Date(yyyy, mm - 1, dd, hh, min, 0, 0);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString();
    }
  }
  return new Date().toISOString();
}
