import { describe, expect, it } from 'vitest';
import type { ClientDictionaryEntry } from '../src/engine/types';
import type {
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
} from '../src/types';
import {
  buildDailyFocusSeries,
  buildPresenceStats,
  buildProjectComparison,
  buildWeeklyAppSummary,
  buildWeeklyDocSummary,
  deriveDynamicWorkstreams,
} from '../src/utils/analyticsMetrics';
import { getProjectColorTokens } from '../src/utils/workspaceConstants';

describe('Component 2: Dynamic Tenant Analytics & Workstream Aggregations', () => {
  const weekDates = [
    '2026-11-19',
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
    '2026-11-23',
    '2026-11-24',
    '2026-11-25',
  ];

  const clients: ClientDictionaryEntry[] = [
    {
      id: 'cli-acme',
      tenantId: 'firm_1',
      legalName: 'Acme Corp',
      aliases: ['Acme'],
      codes: ['ACM-01'],
      folderPatterns: ['/clients/acme'],
      knownDomains: ['acme.example'],
      restrictedUserIds: [],
      source: 'manual',
      updatedAtUtc: '2026-11-25T00:00:00Z',
    },
    {
      id: 'cli-beacon',
      tenantId: 'firm_1',
      legalName: 'Beacon Health',
      aliases: ['Beacon'],
      codes: ['BCN-02'],
      folderPatterns: ['/clients/beacon'],
      knownDomains: ['beacon.example'],
      restrictedUserIds: [],
      source: 'manual',
      updatedAtUtc: '2026-11-25T00:00:00Z',
    },
  ];

  const tasks: Task[] = [
    {
      id: 't1',
      title: 'Q3 Bank Reconciliation',
      description: '',
      project: 'Acme Corp',
      category: 'billable',
      tags: ['close', 'q3'],
      status: 'completed',
      priority: 'high',
      estimatedMinutes: 120,
      dueDate: '2026-11-25',
      subtasks: [],
      createdAt: '2026-11-20',
    },
    {
      id: 't2',
      title: '1099 Vendor Review',
      description: '',
      project: 'Acme Corp',
      category: 'billable',
      tags: ['tax'],
      status: 'blocked',
      priority: 'medium',
      estimatedMinutes: 60,
      dueDate: '2026-11-26',
      subtasks: [],
      createdAt: '2026-11-21',
    },
    {
      id: 't3',
      title: 'Payroll Compliance Memo',
      description: '',
      project: 'Beacon Health',
      category: 'deep_work',
      tags: ['audit'],
      status: 'in_progress',
      priority: 'urgent',
      estimatedMinutes: 90,
      dueDate: '2026-11-25',
      subtasks: [],
      createdAt: '2026-11-22',
    },
    {
      id: 't4',
      title: 'CPE Ethics Training',
      description: '',
      project: 'Internal Firm',
      category: 'admin',
      tags: ['training'],
      status: 'todo',
      priority: 'low',
      estimatedMinutes: 60,
      dueDate: '2026-11-28',
      subtasks: [],
      createdAt: '2026-11-23',
    },
  ];

  const timeBlocks: TimeBlock[] = [
    {
      id: 'b1',
      taskId: 't1',
      title: 'Q3 Bank Reconciliation',
      project: 'Acme Corp',
      category: 'billable',
      tags: ['close'],
      date: '2026-11-24',
      startTime: 540,
      endTime: 630,
      durationMinutes: 90,
      source: 'reconciled',
      isBillable: true,
      notes: '',
    },
    {
      id: 'b2',
      taskId: 't3',
      title: 'Payroll Compliance Memo',
      project: 'Beacon Health',
      category: 'deep_work',
      tags: ['audit'],
      date: '2026-11-25',
      startTime: 600,
      endTime: 660,
      durationMinutes: 60,
      source: 'manual',
      isBillable: false,
      notes: '',
    },
    {
      id: 'b3',
      taskId: null,
      title: 'Historical October Close',
      project: 'Northstar Logistics',
      category: 'billable',
      tags: ['legacy'],
      date: '2026-10-15',
      startTime: 540,
      endTime: 600,
      durationMinutes: 60,
      source: 'manual',
      isBillable: true,
      notes: '',
    },
  ];

  it('derives dynamic client and task workstreams without injecting static demo PROJECTS', () => {
    const workstreams = deriveDynamicWorkstreams({
      clients,
      tasks,
      timeBlocks,
    });

    expect(workstreams).toEqual([
      'Acme Corp',
      'Beacon Health',
      'Internal Firm',
      'Northstar Logistics',
    ]);
    expect(workstreams).not.toContain('Core Platform');
    expect(workstreams).not.toContain('Analytics Engine');
  });

  it('computes accurate weekly vs all-recorded project comparison rows and respects search queries', () => {
    const weeklyRows = buildProjectComparison({
      clients,
      tasks,
      timeBlocks,
      weekDates,
    });

    const acme = weeklyRows.find((r) => r.project === 'Acme Corp')!;
    expect(acme).toMatchObject({
      isConfiguredClient: true,
      taskCount: 2,
      completedTasks: 1,
      blockedTasks: 1,
      plannedMins: 180,
      actualMins: 90,
      billableMins: 90,
      utilizationPercent: 50,
    });

    const northstarWeekly = weeklyRows.find(
      (r) => r.project === 'Northstar Logistics'
    )!;
    expect(northstarWeekly.actualMins).toBe(0);
    expect(northstarWeekly.utilizationPercent).toBeNull();

    const allTimeRows = buildProjectComparison({
      clients,
      tasks,
      timeBlocks,
    });
    const northstarAll = allTimeRows.find(
      (r) => r.project === 'Northstar Logistics'
    )!;
    expect(northstarAll.actualMins).toBe(60);

    const searched = buildProjectComparison({
      clients,
      tasks,
      timeBlocks,
      weekDates,
      searchQuery: '1099 Vendor',
    });
    expect(searched.map((r) => r.project)).toEqual(['Acme Corp']);
  });

  it('computes daily focus series, presence stats, app share, and top documents', () => {
    const daily = buildDailyFocusSeries({ weekDates, timeBlocks });
    expect(daily).toHaveLength(7);
    expect(daily.find((d) => d.date === '2026-11-24')?.billableMins).toBe(90);
    expect(daily.find((d) => d.date === '2026-11-25')?.deepMins).toBe(60);

    const activity: ActivitySegment[] = [
      { id: 'a1', date: '2026-11-25', startTime: 540, endTime: 630, state: 'active', label: 'Active', reconciled: true },
      { id: 'a2', date: '2026-11-25', startTime: 630, endTime: 640, state: 'idle', label: 'Idle', reconciled: true },
      { id: 'a3', date: '2026-11-25', startTime: 640, endTime: 660, state: 'away', label: 'Away', reconciled: true },
    ];
    expect(buildPresenceStats(activity, weekDates)).toEqual({
      activeMins: 90,
      idleMins: 10,
      awayMins: 20,
      focusEfficiency: 75,
    });

    const apps: ApplicationUsageSegment[] = [
      { id: 'ap1', date: '2026-11-25', startTime: 540, endTime: 600, appName: 'Microsoft Excel', appCategory: 'docs' },
      { id: 'ap2', date: '2026-11-25', startTime: 600, endTime: 620, appName: 'QuickBooks Online', appCategory: 'browser' },
    ];
    expect(buildWeeklyAppSummary({ appSegments: apps, weekDates })).toEqual([
      { appName: 'Microsoft Excel', mins: 60, sharePct: 75 },
      { appName: 'QuickBooks Online', mins: 20, sharePct: 25 },
    ]);

    const docs: DocumentUsageSegment[] = [
      {
        id: 'd1',
        date: '2026-11-25',
        startTime: 540,
        endTime: 585,
        appName: 'Microsoft Excel',
        documentTitle: 'Acme_Bank_Rec.xlsx',
        domainOrPath: '~/Acme/Acme_Bank_Rec.xlsx',
        linkedTaskId: 't1',
      },
      {
        id: 'd2',
        date: '2026-11-25',
        startTime: 585,
        endTime: 600,
        appName: 'Microsoft Excel',
        documentTitle: 'Acme_Bank_Rec.xlsx',
        domainOrPath: '~/Acme/Acme_Bank_Rec.xlsx',
        linkedTaskId: 't1',
      },
    ];
    expect(
      buildWeeklyDocSummary({ documentSegments: docs, weekDates, searchQuery: 'Bank' })
    ).toHaveLength(1);
    expect(
      buildWeeklyDocSummary({ documentSegments: docs, weekDates })[0].mins
    ).toBe(60);

    const tokenA = getProjectColorTokens('Acme Corp');
    const tokenB = getProjectColorTokens('Beacon Health');
    expect(tokenA.bar).toMatch(/^bg-/);
    expect(tokenB.border).toMatch(/^border-/);
  });
});
