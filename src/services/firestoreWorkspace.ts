import { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
  UserProfile,
  WeeklyReport,
  WorkspacePreferences,
} from '../types';
import { DEFAULT_PREFERENCES } from '../data/seedData';

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  return cleaned || `id-${Date.now()}`;
}

function clampStr(val: string | undefined | null, maxLen: number): string {
  return String(val ?? '').slice(0, maxLen);
}

function clampPrefs(prefs?: Partial<WorkspacePreferences>): WorkspacePreferences {
  const merged = { ...DEFAULT_PREFERENCES, ...prefs };
  return {
    idleThresholdSeconds: Math.max(
      15,
      Math.min(3600, Number(merged.idleThresholdSeconds) || 60)
    ),
    workdayStartHour: Math.max(
      0,
      Math.min(23, Math.floor(Number(merged.workdayStartHour) ?? 8))
    ),
    workdayEndHour: Math.max(
      1,
      Math.min(24, Math.floor(Number(merged.workdayEndHour) ?? 19))
    ),
    darkMode: Boolean(merged.darkMode),
    autoPauseOnIdle: Boolean(merged.autoPauseOnIdle),
  };
}

function buildTaskPayload(uid: string, task: Task, isCreate: boolean) {
  const cleanId = sanitizeId(task.id);
  const payload: Record<string, unknown> = {
    ownerId: uid,
    title: clampStr(task.title.trim() || 'Untitled Task', 200),
    description: clampStr(task.description, 2000),
    project: clampStr(task.project.trim() || 'Core Platform', 80),
    status: task.status,
    priority: task.priority,
    category: task.category,
    tags: (task.tags || [])
      .slice(0, 20)
      .map((t) => clampStr(t.trim(), 50))
      .filter(Boolean),
    estimatedMinutes: Math.max(0, Math.min(10080, Number(task.estimatedMinutes) || 0)),
    subtasks: (task.subtasks || []).slice(0, 30).map((s) => ({
      id: sanitizeId(s.id),
      title: clampStr(s.title, 200),
      completed: Boolean(s.completed),
    })),
    updatedAt: serverTimestamp(),
  };

  if (task.blockerNote && task.blockerNote.trim()) {
    payload.blockerNote = clampStr(task.blockerNote.trim(), 1000);
  }
  if (task.startDate && task.startDate.trim()) {
    payload.startDate = clampStr(task.startDate.trim(), 20);
  }
  if (task.dueDate && task.dueDate.trim()) {
    payload.dueDate = clampStr(task.dueDate.trim(), 20);
  }
  if (task.completedAt && task.completedAt.trim()) {
    payload.completedDate = clampStr(task.completedAt.trim(), 20);
  }

  if (isCreate) {
    payload.id = cleanId;
    payload.createdDate = clampStr(task.createdAt || new Date().toISOString().slice(0, 10), 20);
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

function buildTimeBlockPayload(uid: string, block: TimeBlock, isCreate: boolean) {
  const cleanId = sanitizeId(block.id);
  const start = Math.max(0, Math.min(1440, Math.round(block.startTime)));
  const end = Math.max(start, Math.min(1440, Math.round(block.endTime)));
  const duration = Math.max(1, Math.min(1440, Math.round(block.durationMinutes || end - start || 15)));

  const payload: Record<string, unknown> = {
    ownerId: uid,
    taskId: block.taskId ? sanitizeId(block.taskId) : null,
    title: clampStr(block.title.trim() || 'Focused Work Session', 200),
    project: clampStr(block.project.trim() || 'Core Platform', 80),
    category: block.category,
    tags: (block.tags || [])
      .slice(0, 20)
      .map((t) => clampStr(t.trim(), 50))
      .filter(Boolean),
    date: clampStr(block.date, 10),
    startTime: start,
    endTime: end,
    durationMinutes: duration,
    source: block.source,
    isBillable: Boolean(block.isBillable),
    notes: clampStr(block.notes, 1000),
    updatedAt: serverTimestamp(),
  };

  if (block.appName && block.appName.trim()) {
    payload.appName = clampStr(block.appName.trim(), 80);
  }
  if (block.documentTitle && block.documentTitle.trim()) {
    payload.documentTitle = clampStr(block.documentTitle.trim(), 250);
  }
  if (isCreate) {
    payload.id = cleanId;
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

function buildActivityPayload(uid: string, seg: ActivitySegment, isCreate: boolean) {
  const cleanId = sanitizeId(seg.id);
  const start = Math.max(0, Math.min(1440, Math.round(seg.startTime)));
  const end = Math.max(start, Math.min(1440, Math.round(seg.endTime)));

  const payload: Record<string, unknown> = {
    ownerId: uid,
    date: clampStr(seg.date, 10),
    startTime: start,
    endTime: end,
    state: seg.state,
    label: clampStr(seg.label.trim() || 'Workstation Activity', 200),
    reconciled: Boolean(seg.reconciled),
    updatedAt: serverTimestamp(),
  };
  if (isCreate) {
    payload.id = cleanId;
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

function buildAppSegPayload(uid: string, seg: ApplicationUsageSegment, isCreate: boolean) {
  const cleanId = sanitizeId(seg.id);
  const start = Math.max(0, Math.min(1440, Math.round(seg.startTime)));
  const end = Math.max(start, Math.min(1440, Math.round(seg.endTime)));

  const payload: Record<string, unknown> = {
    ownerId: uid,
    date: clampStr(seg.date, 10),
    startTime: start,
    endTime: end,
    appName: clampStr(seg.appName.trim() || 'VS Code', 80),
    appCategory: seg.appCategory,
    updatedAt: serverTimestamp(),
  };
  if (isCreate) {
    payload.id = cleanId;
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

function buildDocSegPayload(uid: string, seg: DocumentUsageSegment, isCreate: boolean) {
  const cleanId = sanitizeId(seg.id);
  const start = Math.max(0, Math.min(1440, Math.round(seg.startTime)));
  const end = Math.max(start, Math.min(1440, Math.round(seg.endTime)));

  const payload: Record<string, unknown> = {
    ownerId: uid,
    date: clampStr(seg.date, 10),
    startTime: start,
    endTime: end,
    appName: clampStr(seg.appName.trim() || 'VS Code', 80),
    documentTitle: clampStr(seg.documentTitle.trim() || 'Active Window', 250),
    domainOrPath: clampStr(seg.domainOrPath, 250),
    linkedTaskId: seg.linkedTaskId ? sanitizeId(seg.linkedTaskId) : null,
    updatedAt: serverTimestamp(),
  };
  if (isCreate) {
    payload.id = cleanId;
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

function buildReportPayload(uid: string, report: WeeklyReport, isCreate: boolean) {
  const cleanId = sanitizeId(report.id);
  const payload: Record<string, unknown> = {
    ownerId: uid,
    weekStartDate: clampStr(report.weekStartDate, 20),
    weekEndDate: clampStr(report.weekEndDate, 20),
    generatedAt: clampStr(report.generatedAt, 40),
    tone: report.tone,
    executiveSummary: clampStr(report.executiveSummary.trim() || 'Weekly summary', 4000),
    accomplishments: (report.accomplishments || []).slice(0, 20).map((s) => clampStr(s, 500)),
    blockersAndRisks: (report.blockersAndRisks || []).slice(0, 20).map((s) => clampStr(s, 500)),
    velocityInsights: clampStr(report.velocityInsights, 2000),
    nextWeekFocus: (report.nextWeekFocus || []).slice(0, 20).map((s) => clampStr(s, 500)),
    metricsSnapshot: {
      totalMinutes: Number(report.metricsSnapshot.totalMinutes) || 0,
      totalHours: Number(report.metricsSnapshot.totalHours) || 0,
      plannedMinutes: Number(report.metricsSnapshot.plannedMinutes) || 0,
      plannedHours: Number(report.metricsSnapshot.plannedHours) || 0,
      deepWorkMinutes: Number(report.metricsSnapshot.deepWorkMinutes) || 0,
      deepWorkPercent: Number(report.metricsSnapshot.deepWorkPercent) || 0,
      billableMinutes: Number(report.metricsSnapshot.billableMinutes) || 0,
      billablePercent: Number(report.metricsSnapshot.billablePercent) || 0,
      completedCount: Number(report.metricsSnapshot.completedCount) || 0,
      totalTasksCount: Number(report.metricsSnapshot.totalTasksCount) || 0,
      completionRate: Number(report.metricsSnapshot.completionRate) || 0,
      estimationAccuracyPercent: Number(report.metricsSnapshot.estimationAccuracyPercent) || 0,
    },
    isAiGenerated: Boolean(report.isAiGenerated),
    updatedAt: serverTimestamp(),
  };
  if (isCreate) {
    payload.id = cleanId;
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

export async function ensureUserProfile(
  user: User,
  fallbackPrefs: WorkspacePreferences
): Promise<{ profile: UserProfile; isNewAccount: boolean }> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (snap.exists()) {
    const data = snap.data();
    return {
      profile: {
        ownerId: data.ownerId,
        email: data.email,
        displayName: data.displayName,
        jobTitle: data.jobTitle || '',
        photoURL: data.photoURL || '',
        hourlyRate: typeof data.hourlyRate === 'number' ? data.hourlyRate : 0,
        currency: data.currency || 'USD',
        preferences: clampPrefs(data.preferences),
      },
      isNewAccount: false,
    };
  }

  const newProfile: UserProfile = {
    ownerId: user.uid,
    email: clampStr(user.email || 'user@ontrack.local', 254),
    displayName: clampStr(
      user.displayName || user.email?.split('@')[0] || 'onTrack User',
      100
    ),
    jobTitle: 'Product & Engineering Lead',
    photoURL: clampStr(user.photoURL || '', 512),
    hourlyRate: 150,
    currency: 'USD',
    preferences: clampPrefs(fallbackPrefs),
  };

  const writePayload: Record<string, unknown> = {
    ownerId: newProfile.ownerId,
    email: newProfile.email,
    displayName: newProfile.displayName,
    jobTitle: newProfile.jobTitle,
    hourlyRate: newProfile.hourlyRate,
    currency: newProfile.currency,
    preferences: newProfile.preferences,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (newProfile.photoURL) {
    writePayload.photoURL = newProfile.photoURL;
  }

  try {
    await setDoc(ref, writePayload);
    return { profile: newProfile, isNewAccount: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateUserProfile(
  uid: string,
  updates: Partial<Omit<UserProfile, 'ownerId' | 'email'>>
): Promise<void> {
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);
  try {
    const payload: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (updates.displayName !== undefined) {
      payload.displayName = clampStr(updates.displayName.trim() || 'onTrack User', 100);
    }
    if (updates.jobTitle !== undefined) {
      payload.jobTitle = clampStr(updates.jobTitle.trim(), 100);
    }
    if (updates.photoURL !== undefined) {
      payload.photoURL = clampStr(updates.photoURL.trim(), 512);
    }
    if (updates.hourlyRate !== undefined) {
      payload.hourlyRate = Math.max(0, Math.min(100000, Number(updates.hourlyRate) || 0));
    }
    if (updates.currency !== undefined) {
      payload.currency = clampStr(updates.currency.trim() || 'USD', 8);
    }
    if (updates.preferences !== undefined) {
      payload.preferences = clampPrefs(updates.preferences);
    }
    await updateDoc(ref, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function seedOrMigrateWorkspaceToCloud(
  uid: string,
  dataset: {
    tasks: Task[];
    timeBlocks: TimeBlock[];
    activitySegments: ActivitySegment[];
    appSegments: ApplicationUsageSegment[];
    documentSegments: DocumentUsageSegment[];
    reports: WeeklyReport[];
  }
): Promise<void> {
  const path = `users/${uid}/batchMigration`;
  try {
    const batch = writeBatch(db);
    dataset.tasks.forEach((t) => {
      const id = sanitizeId(t.id);
      batch.set(doc(db, 'users', uid, 'tasks', id), buildTaskPayload(uid, t, true));
    });
    dataset.timeBlocks.forEach((b) => {
      const id = sanitizeId(b.id);
      batch.set(doc(db, 'users', uid, 'timeBlocks', id), buildTimeBlockPayload(uid, b, true));
    });
    dataset.activitySegments.forEach((s) => {
      const id = sanitizeId(s.id);
      batch.set(
        doc(db, 'users', uid, 'activitySegments', id),
        buildActivityPayload(uid, s, true)
      );
    });
    dataset.appSegments.forEach((a) => {
      const id = sanitizeId(a.id);
      batch.set(
        doc(db, 'users', uid, 'appSegments', id),
        buildAppSegPayload(uid, a, true)
      );
    });
    dataset.documentSegments.forEach((d) => {
      const id = sanitizeId(d.id);
      batch.set(
        doc(db, 'users', uid, 'documentSegments', id),
        buildDocSegPayload(uid, d, true)
      );
    });
    dataset.reports.forEach((r) => {
      const id = sanitizeId(r.id);
      batch.set(doc(db, 'users', uid, 'reports', id), buildReportPayload(uid, r, true));
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function createTaskInCloud(uid: string, task: Task): Promise<void> {
  const id = sanitizeId(task.id);
  const path = `users/${uid}/tasks/${id}`;
  try {
    await setDoc(doc(db, 'users', uid, 'tasks', id), buildTaskPayload(uid, task, true));
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateTaskInCloud(
  uid: string,
  taskId: string,
  updates: Partial<Task>
): Promise<void> {
  const id = sanitizeId(taskId);
  const path = `users/${uid}/tasks/${id}`;
  try {
    const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (updates.title !== undefined) payload.title = clampStr(updates.title.trim() || 'Untitled Task', 200);
    if (updates.description !== undefined) payload.description = clampStr(updates.description, 2000);
    if (updates.project !== undefined) payload.project = clampStr(updates.project, 80);
    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.priority !== undefined) payload.priority = updates.priority;
    if (updates.category !== undefined) payload.category = updates.category;
    if (updates.tags !== undefined) {
      payload.tags = updates.tags.slice(0, 20).map((t) => clampStr(t.trim(), 50)).filter(Boolean);
    }
    if (updates.estimatedMinutes !== undefined) {
      payload.estimatedMinutes = Math.max(0, Math.min(10080, Number(updates.estimatedMinutes) || 0));
    }
    if (updates.blockerNote !== undefined && updates.blockerNote.trim()) {
      payload.blockerNote = clampStr(updates.blockerNote.trim(), 1000);
    }
    if (updates.subtasks !== undefined) {
      payload.subtasks = updates.subtasks.slice(0, 30).map((s) => ({
        id: sanitizeId(s.id),
        title: clampStr(s.title, 200),
        completed: Boolean(s.completed),
      }));
    }
    if (updates.startDate !== undefined && updates.startDate.trim()) {
      payload.startDate = clampStr(updates.startDate.trim(), 20);
    }
    if (updates.dueDate !== undefined && updates.dueDate.trim()) {
      payload.dueDate = clampStr(updates.dueDate.trim(), 20);
    }
    if (updates.completedAt !== undefined && updates.completedAt.trim()) {
      payload.completedDate = clampStr(updates.completedAt.trim(), 20);
    }
    await updateDoc(doc(db, 'users', uid, 'tasks', id), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteTaskInCloud(uid: string, taskId: string): Promise<void> {
  const id = sanitizeId(taskId);
  const path = `users/${uid}/tasks/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'tasks', id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveTimeBlockInCloud(
  uid: string,
  block: TimeBlock,
  isUpdate: boolean
): Promise<void> {
  const id = sanitizeId(block.id);
  const path = `users/${uid}/timeBlocks/${id}`;
  try {
    if (isUpdate) {
      const payload = buildTimeBlockPayload(uid, block, false);
      delete payload.ownerId;
      await updateDoc(doc(db, 'users', uid, 'timeBlocks', id), payload);
    } else {
      await setDoc(doc(db, 'users', uid, 'timeBlocks', id), buildTimeBlockPayload(uid, block, true));
    }
  } catch (error) {
    handleFirestoreError(error, isUpdate ? OperationType.UPDATE : OperationType.CREATE, path);
  }
}

export async function deleteTimeBlockInCloud(uid: string, blockId: string): Promise<void> {
  const id = sanitizeId(blockId);
  const path = `users/${uid}/timeBlocks/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'timeBlocks', id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveActivitySegmentInCloud(
  uid: string,
  seg: ActivitySegment,
  isUpdate: boolean
): Promise<void> {
  const id = sanitizeId(seg.id);
  const path = `users/${uid}/activitySegments/${id}`;
  try {
    if (isUpdate) {
      await updateDoc(doc(db, 'users', uid, 'activitySegments', id), {
        state: seg.state,
        label: clampStr(seg.label, 200),
        reconciled: Boolean(seg.reconciled),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        doc(db, 'users', uid, 'activitySegments', id),
        buildActivityPayload(uid, seg, true)
      );
    }
  } catch (error) {
    handleFirestoreError(error, isUpdate ? OperationType.UPDATE : OperationType.CREATE, path);
  }
}

export async function createAppSegmentInCloud(
  uid: string,
  seg: ApplicationUsageSegment
): Promise<void> {
  const id = sanitizeId(seg.id);
  const path = `users/${uid}/appSegments/${id}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'appSegments', id),
      buildAppSegPayload(uid, seg, true)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function createDocSegmentInCloud(
  uid: string,
  seg: DocumentUsageSegment
): Promise<void> {
  const id = sanitizeId(seg.id);
  const path = `users/${uid}/documentSegments/${id}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'documentSegments', id),
      buildDocSegPayload(uid, seg, true)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function createReportInCloud(
  uid: string,
  report: WeeklyReport
): Promise<void> {
  const id = sanitizeId(report.id);
  const path = `users/${uid}/reports/${id}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'reports', id),
      buildReportPayload(uid, report, true)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function clearAndDeleteUserWorkspace(uid: string): Promise<void> {
  const subcollections = [
    'tasks',
    'timeBlocks',
    'activitySegments',
    'appSegments',
    'documentSegments',
    'reports',
  ];
  try {
    const batch = writeBatch(db);
    for (const colName of subcollections) {
      const snap = await getDocs(
        query(collection(db, 'users', uid, colName), where('ownerId', '==', uid))
      );
      snap.forEach((d) => batch.delete(d.ref));
    }
    batch.delete(doc(db, 'users', uid));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `users/${uid}`);
  }
}

export function subscribeToUserWorkspace(
  uid: string,
  handlers: {
    onProfile: (profile: UserProfile) => void;
    onTasks: (tasks: Task[]) => void;
    onTimeBlocks: (blocks: TimeBlock[]) => void;
    onActivitySegments: (segments: ActivitySegment[]) => void;
    onAppSegments: (segments: ApplicationUsageSegment[]) => void;
    onDocumentSegments: (segments: DocumentUsageSegment[]) => void;
    onReports: (reports: WeeklyReport[]) => void;
  },
  onError: (err: unknown) => void
): () => void {
  const unsubs: Unsubscribe[] = [];

  unsubs.push(
    onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          handlers.onProfile({
            ownerId: d.ownerId,
            email: d.email,
            displayName: d.displayName,
            jobTitle: d.jobTitle || '',
            photoURL: d.photoURL || '',
            hourlyRate: typeof d.hourlyRate === 'number' ? d.hourlyRate : 0,
            currency: d.currency || 'USD',
            preferences: clampPrefs(d.preferences),
          });
        }
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.GET, `users/${uid}`);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  const tasksPath = `users/${uid}/tasks`;
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'tasks'), where('ownerId', '==', uid)),
      (snap) => {
        const list: Task[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: data.id || d.id,
            title: data.title,
            description: data.description || '',
            project: data.project,
            status: data.status,
            priority: data.priority,
            category: data.category,
            tags: Array.isArray(data.tags) ? data.tags : [],
            estimatedMinutes: Number(data.estimatedMinutes) || 0,
            blockerNote: data.blockerNote,
            subtasks: Array.isArray(data.subtasks) ? data.subtasks : [],
            createdAt: data.createdDate || '',
            startDate: data.startDate,
            dueDate: data.dueDate,
            completedAt: data.completedDate,
          };
        });
        handlers.onTasks(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, tasksPath);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  const blocksPath = `users/${uid}/timeBlocks`;
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'timeBlocks'), where('ownerId', '==', uid)),
      (snap) => {
        const list: TimeBlock[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: data.id || d.id,
            taskId: data.taskId ?? null,
            title: data.title,
            project: data.project,
            category: data.category,
            tags: Array.isArray(data.tags) ? data.tags : [],
            date: data.date,
            startTime: Number(data.startTime) || 0,
            endTime: Number(data.endTime) || 0,
            durationMinutes: Number(data.durationMinutes) || 0,
            source: data.source,
            isBillable: Boolean(data.isBillable),
            notes: data.notes || '',
            appName: data.appName,
            documentTitle: data.documentTitle,
          };
        });
        handlers.onTimeBlocks(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, blocksPath);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  const segsPath = `users/${uid}/activitySegments`;
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'activitySegments'), where('ownerId', '==', uid)),
      (snap) => {
        const list: ActivitySegment[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: data.id || d.id,
            date: data.date,
            startTime: Number(data.startTime) || 0,
            endTime: Number(data.endTime) || 0,
            state: data.state,
            label: data.label,
            reconciled: Boolean(data.reconciled),
          };
        });
        handlers.onActivitySegments(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, segsPath);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  const appPath = `users/${uid}/appSegments`;
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'appSegments'), where('ownerId', '==', uid)),
      (snap) => {
        const list: ApplicationUsageSegment[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: data.id || d.id,
            date: data.date,
            startTime: Number(data.startTime) || 0,
            endTime: Number(data.endTime) || 0,
            appName: data.appName,
            appCategory: data.appCategory,
          };
        });
        handlers.onAppSegments(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, appPath);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  const docPath = `users/${uid}/documentSegments`;
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'documentSegments'), where('ownerId', '==', uid)),
      (snap) => {
        const list: DocumentUsageSegment[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: data.id || d.id,
            date: data.date,
            startTime: Number(data.startTime) || 0,
            endTime: Number(data.endTime) || 0,
            appName: data.appName,
            documentTitle: data.documentTitle,
            domainOrPath: data.domainOrPath || '',
            linkedTaskId: data.linkedTaskId ?? null,
          };
        });
        handlers.onDocumentSegments(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, docPath);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  const repPath = `users/${uid}/reports`;
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'reports'), where('ownerId', '==', uid)),
      (snap) => {
        const list: WeeklyReport[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: data.id || d.id,
              weekStartDate: data.weekStartDate,
              weekEndDate: data.weekEndDate,
              generatedAt: data.generatedAt,
              tone: data.tone,
              executiveSummary: data.executiveSummary,
              accomplishments: Array.isArray(data.accomplishments) ? data.accomplishments : [],
              blockersAndRisks: Array.isArray(data.blockersAndRisks) ? data.blockersAndRisks : [],
              velocityInsights: data.velocityInsights || '',
              nextWeekFocus: Array.isArray(data.nextWeekFocus) ? data.nextWeekFocus : [],
              metricsSnapshot: data.metricsSnapshot,
              isAiGenerated: Boolean(data.isAiGenerated),
            };
          })
          .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
        handlers.onReports(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, repPath);
        } catch (wrapped) {
          onError(wrapped);
        }
      }
    )
  );

  return () => {
    unsubs.forEach((u) => u());
  };
}
