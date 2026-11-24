import {
  AttributionRecord,
  AttributionStatus,
  AutoChecklistItem,
  EngineTask,
  LearnedRule,
  TaskTemplate,
  TenantConfig,
  TrackingEvent,
  WorkSession,
} from './types';

function clampConfidence(v: number): number {
  return Math.max(0, Math.min(0.99, Math.round(v * 100) / 100));
}

function classifyStatus(
  confidence: number,
  config: TenantConfig
): AttributionStatus {
  if (confidence >= config.confidenceThresholds.detected) return 'detected';
  if (confidence >= config.confidenceThresholds.suggested) return 'suggested';
  return 'review_tray';
}

function matchesLearnedRule(session: WorkSession, rule: LearnedRule): boolean {
  const p = rule.pattern.toLowerCase();
  if (!p) return false;
  const haystacks = [
    session.primaryTitle.toLowerCase(),
    (session.primaryPath || '').toLowerCase(),
    (session.primaryUrl || '').toLowerCase(),
  ];
  const clean = p.replace(/\*/g, '');
  return haystacks.some((h) => h.includes(clean));
}

export interface AttributionPipelineOutput {
  attributions: AttributionRecord[];
  checklistItems: AutoChecklistItem[];
  revisionsPublished: {
    sessionId: string;
    previousReason: string;
    newReason: string;
    newTaskId: string | null;
    newConfidence: number;
  }[];
}

/**
 * Stages 5 & 6: Attribution Engine + Context Propagation + Retroactive Revision + Auto-Checklists
 *
 * Scoring signals (strongest first):
 * 1. User's explicitly active task
 * 2. Client + Period matches from titles, paths, URLs
 * 3. Today's task list & due dates
 * 4. Context from neighboring blocks (Context Propagation & Retroactive Attribution)
 * 5. User's past learned rules (respecting rejected generalizations)
 */
export function runAttributionPipeline(params: {
  sessions: WorkSession[];
  rawEvents: TrackingEvent[];
  tasks: EngineTask[];
  templates: TaskTemplate[];
  learnedRules: LearnedRule[];
  config: TenantConfig;
  existingConfirmations?: Map<string, AttributionRecord>;
}): AttributionPipelineOutput {
  const {
    sessions,
    rawEvents,
    tasks,
    templates,
    learnedRules,
    config,
    existingConfirmations,
  } = params;

  const eventMap = new Map<string, TrackingEvent>();
  for (const ev of rawEvents) {
    eventMap.set(ev.event_id, ev);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const attributions: AttributionRecord[] = [];
  const revisionsPublished: AttributionPipelineOutput['revisionsPublished'] = [];

  // Pass 1: Direct 5-Signal Scoring per session
  for (const session of sessions) {
    const existing = existingConfirmations?.get(session.id);
    if (existing && existing.status === 'confirmed') {
      attributions.push(existing);
      continue;
    }

    if (session.isIdle) {
      attributions.push({
        id: `attr-${session.id}`,
        sessionId: session.id,
        tenantId: session.tenantId,
        userId: session.userId,
        taskId: null,
        taskTitle: null,
        clientId: null,
        clientName: null,
        stepId: null,
        stepTitle: null,
        period: null,
        confidence: 0.15,
        reason: 'Workstation idle interval queued for user review/tagging',
        status: 'review_tray',
        version: 1,
        retroactiveRevision: false,
        updatedAtUtc: new Date().toISOString(),
      });
      continue;
    }

    // Check explicit active task from contributing events
    let explicitTaskId: string | null = null;
    for (const eid of session.eventIds) {
      const ev = eventMap.get(eid);
      if (ev?.payload.active_task_id) {
        explicitTaskId = ev.payload.active_task_id;
        break;
      }
    }

    // Check accepted learned rules (skip rejected ones)
    const matchingRule = learnedRules.find(
      (r) =>
        r.accepted &&
        r.userId === session.userId &&
        matchesLearnedRule(session, r)
    );

    const rejectedRule = learnedRules.find(
      (r) =>
        !r.accepted &&
        r.userId === session.userId &&
        matchesLearnedRule(session, r)
    );

    const candidateTasks = tasks.filter((t) => t.tenantId === session.tenantId);

    let bestTask: EngineTask | null = null;
    let bestScore = 0;
    let bestReasons: string[] = [];

    for (const task of candidateTasks) {
      let score = 0;
      const reasons: string[] = [];

      // Signal 1: Explicitly active task
      if (explicitTaskId && explicitTaskId === task.id) {
        score += 0.62;
        reasons.push('explicitly active user task');
      }

      // Signal 2: Client & period match
      const effectiveClientId =
        session.entities.clientId ||
        (matchingRule ? matchingRule.targetClientId : null);

      if (effectiveClientId && task.clientId === effectiveClientId) {
        score += session.entities.clientId ? 0.52 : 0.44;
        if (session.entities.signals.length > 0) {
          reasons.push(session.entities.signals[0]);
        } else if (matchingRule) {
          reasons.push(`learned rule "${matchingRule.pattern}"`);
        }
      }

      if (session.entities.period && task.period) {
        if (
          session.entities.period.toLowerCase() === task.period.toLowerCase()
        ) {
          score += 0.24;
          reasons.push(`exact period match '${task.period}'`);
        } else {
          // Period mismatch penalty (separates Oct 2026 close from Sep 2026 close)
          score -= 0.32;
          reasons.push(`period mismatch (${session.entities.period} vs ${task.period})`);
        }
      }

      // Activity / task keyword overlap
      const titleLower = `${session.primaryTitle} ${session.entities.activityType || ''} ${session.entities.docType || ''}`.toLowerCase();
      const taskWords = task.title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      const wordHits = taskWords.filter((w) => titleLower.includes(w));
      if (wordHits.length > 0) {
        score += Math.min(0.18, wordHits.length * 0.08);
        reasons.push(`keyword match (${wordHits.slice(0, 2).join(', ')})`);
      }

      // Signal 3: Today's active task list & due date proximity (primary owner or collaborator)
      const isPrimaryOwner = task.assignedUserId === session.userId;
      const isCollaborator = Boolean(
        task.collaboratorUserIds?.includes(session.userId)
      );
      if (isPrimaryOwner || isCollaborator) {
        if (task.status === 'in_progress') {
          score += 0.10;
          reasons.push(
            isPrimaryOwner
              ? 'assigned in-progress task'
              : 'collaborating on shared in-progress task'
          );
        }
        if (task.dueDateUtc.slice(0, 10) >= todayIso) {
          score += 0.05;
        }
      }

      // Signal 5: Learned rule directly targeting this task
      if (matchingRule && matchingRule.targetTaskId === task.id) {
        score += 0.22;
        reasons.push(`past correction rule "${matchingRule.pattern}"`);
      }

      if (score > bestScore) {
        bestScore = score;
        bestTask = task;
        bestReasons = reasons;
      }
    }

    // Fallback when client matched via dictionary/rule even if no active task exists yet
    let clientOnlyConfidence = 0;
    if (!bestTask && session.entities.clientId) {
      clientOnlyConfidence = 0.62;
      bestReasons = [...session.entities.signals];
    }

    // Fallback penalty if browser extension is disconnected on browser activity
    const isBrowserWindow = /chrome|edge|firefox|safari|browser/i.test(
      session.primaryApp
    );
    if (!session.extensionConnected && isBrowserWindow) {
      bestScore -= 0.12;
      clientOnlyConfidence = Math.max(0, clientOnlyConfidence - 0.12);
      bestReasons.push('browser extension absent (window-title fallback)');
    }

    if (rejectedRule) {
      bestReasons.push(`skipped rejected rule "${rejectedRule.pattern}"`);
    }

    const finalConfidence = clampConfidence(
      bestTask ? bestScore : clientOnlyConfidence || 0.22
    );
    const status = classifyStatus(finalConfidence, config);

    // Match template step if task matched
    let matchedStepId: string | null = null;
    let matchedStepTitle: string | null = null;
    if (bestTask?.templateId) {
      const tpl = templates.find((t) => t.id === bestTask!.templateId);
      if (tpl) {
        const searchStr = `${session.primaryTitle} ${session.primaryPath || ''} ${session.primaryUrl || ''} ${session.entities.activityType || ''}`.toLowerCase();
        const foundStep = tpl.steps.find((st) =>
          searchStr.includes(st.activitySignature.toLowerCase())
        );
        if (foundStep) {
          matchedStepId = foundStep.id;
          matchedStepTitle = foundStep.title;
        }
      }
    }

    attributions.push({
      id: `attr-${session.id}`,
      sessionId: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      taskId: status === 'review_tray' ? null : bestTask?.id || null,
      taskTitle: status === 'review_tray' ? null : bestTask?.title || null,
      clientId:
        status === 'review_tray'
          ? null
          : bestTask?.clientId || session.entities.clientId || null,
      clientName:
        status === 'review_tray'
          ? null
          : bestTask?.clientName || session.entities.clientName || null,
      stepId: status === 'review_tray' ? null : matchedStepId,
      stepTitle: status === 'review_tray' ? null : matchedStepTitle,
      period: session.entities.period || bestTask?.period || null,
      confidence: finalConfidence,
      reason:
        bestReasons.length > 0
          ? bestReasons.join(' + ')
          : `Low-signal window "${session.primaryTitle}" (${session.primaryApp}) queued in Review Tray`,
      status,
      version: 1,
      retroactiveRevision: false,
      updatedAtUtc: new Date().toISOString(),
    });
  }

  // Pass 2: Context Propagation & Retroactive Attribution (ATTR-3)
  // If an ambiguous session (< suggested threshold, non-idle) is adjacent (<= 15m)
  // to a strong/detected session (>= 0.85) or sandwiched between matching client blocks,
  // propagate attribution and emit a retroactive revision when a LATER strong signal explains an EARLIER block.
  for (let i = 0; i < attributions.length; i++) {
    const currAttr = attributions[i];
    const currSess = sessions[i];
    if (!currSess || currSess.isIdle || currAttr.status !== 'review_tray') {
      continue;
    }

    const currStart = Date.parse(currSess.startTimeUtc);
    const currEnd = Date.parse(currSess.endTimeUtc);

    const isGenericScratchApp = /^(notepad|notes|calculator|terminal)$/i.test(
      currSess.primaryApp.trim()
    );
    if (isGenericScratchApp) {
      continue;
    }

    // Look ahead first for Retroactive Attribution (strong signal arriving AFTER ambiguous block)
    let strongLater: { attr: AttributionRecord; sess: WorkSession } | null = null;
    for (let j = i + 1; j < attributions.length; j++) {
      const nextSess = sessions[j];
      const nextAttr = attributions[j];
      if (!nextSess || nextSess.userId !== currSess.userId) continue;
      const gapMs = Date.parse(nextSess.startTimeUtc) - currEnd;
      if (gapMs > 15 * 60 * 1000) break;
      if (nextAttr.confidence >= config.confidenceThresholds.detected && nextAttr.clientId) {
        strongLater = { attr: nextAttr, sess: nextSess };
        break;
      }
    }

    // Look behind for forward Context Propagation
    let strongPrev: { attr: AttributionRecord; sess: WorkSession } | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prevSess = sessions[j];
      const prevAttr = attributions[j];
      if (!prevSess || prevSess.userId !== currSess.userId) continue;
      const gapMs = currStart - Date.parse(prevSess.endTimeUtc);
      if (gapMs > 10 * 60 * 1000) break;
      if (prevAttr.confidence >= 0.72 && prevAttr.clientId) {
        strongPrev = { attr: prevAttr, sess: prevSess };
        break;
      }
    }

    const donor = strongLater || strongPrev;
    if (donor) {
      const isRetroactive = Boolean(strongLater);
      const previousReason = currAttr.reason;
      const propagatedConfidence = isRetroactive ? 0.78 : 0.68;
      const newReason = isRetroactive
        ? `Retroactively attributed from subsequent strong signal (${donor.attr.clientName} · ${donor.sess.primaryApp}: "${donor.sess.primaryTitle}")`
        : `Context propagated from adjacent ${donor.attr.clientName} session`;

      attributions[i] = {
        ...currAttr,
        taskId: donor.attr.taskId,
        taskTitle: donor.attr.taskTitle,
        clientId: donor.attr.clientId,
        clientName: donor.attr.clientName,
        period: currAttr.period || donor.attr.period,
        confidence: propagatedConfidence,
        status: 'suggested',
        reason: newReason,
        version: currAttr.version + 1,
        retroactiveRevision: isRetroactive,
        revisedFromReason: isRetroactive ? previousReason : undefined,
        updatedAtUtc: new Date().toISOString(),
      };

      if (isRetroactive) {
        revisionsPublished.push({
          sessionId: currSess.id,
          previousReason,
          newReason,
          newTaskId: donor.attr.taskId,
          newConfidence: propagatedConfidence,
        });
      }
    }
  }

  // Stage 6: Auto-Checklist Generator
  const checklistItems: AutoChecklistItem[] = [];
  const taskSessionsMap = new Map<string, { session: WorkSession; attr: AttributionRecord }[]>();

  for (let i = 0; i < sessions.length; i++) {
    const attr = attributions[i];
    const sess = sessions[i];
    if (!attr.taskId) continue;
    const arr = taskSessionsMap.get(attr.taskId) || [];
    arr.push({ session: sess, attr });
    taskSessionsMap.set(attr.taskId, arr);
  }

  for (const task of tasks) {
    const pairs = taskSessionsMap.get(task.id) || [];
    const tpl = task.templateId
      ? templates.find((t) => t.id === task.templateId)
      : undefined;

    const usedSessionIds = new Set<string>();

    if (tpl) {
      for (const step of tpl.steps) {
        const matchingPairs = pairs.filter(
          (p) =>
            p.attr.stepId === step.id ||
            `${p.session.primaryTitle} ${p.session.primaryPath || ''} ${p.session.entities.activityType || ''}`
              .toLowerCase()
              .includes(step.activitySignature.toLowerCase())
        );

        if (matchingPairs.length > 0) {
          matchingPairs.forEach((p) => usedSessionIds.add(p.session.id));
          const totalMins = Math.max(
            1,
            Math.round(
              matchingPairs.reduce((acc, p) => acc + p.session.durationSeconds, 0) / 60
            )
          );
          const hasConfirmed = matchingPairs.some((p) => p.attr.status === 'confirmed');
          const hasDetected = matchingPairs.some((p) => p.attr.status === 'detected');
          checklistItems.push({
            id: `chk-${task.id}-${step.id}`,
            tenantId: task.tenantId,
            taskId: task.id,
            userId: matchingPairs[0]?.session.userId || task.assignedUserId,
            stepId: step.id,
            orderIndex: step.order,
            title: step.title,
            status: hasConfirmed ? 'confirmed' : hasDetected ? 'detected' : 'suggested',
            minutesAccumulated: totalMins,
            sourceSessionIds: matchingPairs.map((p) => p.session.id),
            reason: `Matched template signature "${step.activitySignature}" across ${matchingPairs.length} session(s)`,
            isFreeForm: false,
            updatedAtUtc: new Date().toISOString(),
          });
        }
      }
    }

    // Free-form items for activity on this task that did not match a template step
    const unmatchedPairs = pairs.filter((p) => !usedSessionIds.has(p.session.id));
    unmatchedPairs.forEach((p, idx) => {
      const mins = Math.max(1, Math.round(p.session.durationSeconds / 60));
      const docLabel = p.session.primaryPath
        ? p.session.primaryPath.split(/[\\/]/).pop()
        : p.session.primaryTitle;
      checklistItems.push({
        id: `chk-free-${task.id}-${p.session.id}`,
        tenantId: task.tenantId,
        taskId: task.id,
        userId: p.session.userId || task.assignedUserId,
        stepId: null,
        orderIndex: 100 + idx,
        title: `Reviewed ${docLabel}, ${mins} min`,
        status:
          p.attr.status === 'confirmed'
            ? 'confirmed'
            : p.attr.status === 'detected'
            ? 'detected'
            : 'suggested',
        minutesAccumulated: mins,
        sourceSessionIds: [p.session.id],
        reason: p.attr.reason,
        isFreeForm: true,
        updatedAtUtc: new Date().toISOString(),
      });
    });
  }

  return {
    attributions,
    checklistItems,
    revisionsPublished,
  };
}

export interface ShiftHandoffSummary {
  taskId: string;
  taskTitle: string;
  clientName: string;
  period: string;
  lastUpdatedUtc: string;
  totalMinutes: number;
  lastDocuments: string[];
  confirmedSteps: string[];
  pendingSteps: string[];
  handoffNote: string;
}

export function buildShiftHandoffSummaries(
  tasks: EngineTask[],
  sessions: WorkSession[],
  attributions: AttributionRecord[],
  checklistItems: AutoChecklistItem[]
): ShiftHandoffSummary[] {
  const summaries: ShiftHandoffSummary[] = [];

  for (const task of tasks) {
    if (task.status === 'completed') continue;
    const taskAttrs = attributions.filter((a) => a.taskId === task.id);
    if (taskAttrs.length === 0) continue;

    const sessionIds = new Set(taskAttrs.map((a) => a.sessionId));
    const taskSessions = sessions
      .filter((s) => sessionIds.has(s.id))
      .sort((a, b) => b.endTimeUtc.localeCompare(a.endTimeUtc));

    const totalMinutes = Math.max(
      1,
      Math.round(taskSessions.reduce((acc, s) => acc + s.durationSeconds, 0) / 60)
    );

    const docs = Array.from(
      new Set(
        taskSessions
          .map((s) => s.primaryPath || s.primaryUrl || s.primaryTitle)
          .filter(Boolean)
      )
    ).slice(0, 3);

    const taskChecks = checklistItems.filter((c) => c.taskId === task.id);
    const confirmed = taskChecks
      .filter((c) => c.status === 'confirmed')
      .map((c) => c.title);
    const pending = taskChecks
      .filter((c) => c.status !== 'confirmed')
      .map((c) => `${c.title} (${c.status})`);

    const latest = taskSessions[0];
    summaries.push({
      taskId: task.id,
      taskTitle: task.title,
      clientName: task.clientName,
      period: task.period,
      lastUpdatedUtc: latest?.endTimeUtc || task.updatedAtUtc,
      totalMinutes,
      lastDocuments: docs,
      confirmedSteps: confirmed,
      pendingSteps: pending,
      handoffNote: latest
        ? `Left off in ${latest.primaryApp} ("${latest.primaryTitle}"). ${pending.length} step(s) awaiting confirmation.`
        : 'Ready for next shift pickup.',
    });
  }

  return summaries;
}
