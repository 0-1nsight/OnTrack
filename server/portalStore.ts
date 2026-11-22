import crypto from 'node:crypto';
import { PortalBrandingConfig, UserRole } from '../src/engine/types.ts';
import { EngineSQLStore } from './engineStore.ts';
import { HttpError } from './errors.ts';

export type PortalRequestStage =
  | 'Documents received'
  | 'In review'
  | 'Awaiting your approval'
  | 'Complete';

export interface ClientPortalRequest {
  id: string;
  tenantId: string;
  clientId: string;
  clientName: string;
  templateId: string | null;
  engineTaskId: string | null;
  title: string;
  period: string;
  stage: PortalRequestStage;
  expectedDueUtc: string;
  notes: string | null;
  approvalStatus: 'pending' | 'approved';
  approvedBy: string | null;
  signatureName: string | null;
  approvalNotes: string | null;
  approvedAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ClientPortalMilestone {
  id: string;
  tenantId: string;
  clientId: string;
  requestId: string;
  title: string;
  status: 'confirmed' | 'withdrawn';
  confirmedAtUtc: string;
  confirmedBy: string;
  withdrawnAtUtc: string | null;
  withdrawalReason: string | null;
  updatedAtUtc: string;
}

export interface ClientPortalDocumentRequest {
  id: string;
  tenantId: string;
  clientId: string;
  requestId: string;
  title: string;
  status: 'pending' | 'uploaded' | 'verified';
  dueDateUtc: string;
  reminderSentAtUtc: string | null;
  isOverdue: boolean;
  uploadedFileId: string | null;
  uploadedFileName: string | null;
  updatedAtUtc: string;
}

export interface ClientPortalMessage {
  id: string;
  tenantId: string;
  clientId: string;
  requestId: string;
  senderName: string;
  senderRole: UserRole;
  body: string;
  createdAtUtc: string;
}

export class PortalSQLStore {
  constructor(private readonly engineStore: EngineSQLStore) {}

  public async ensureDemoPortalSeeded(tenantId: string): Promise<void> {
    if (tenantId !== 'firm_demo') return;
    await this.engineStore.ready();

    const existing = await this.engineStore.db.withTenantTransaction(
      { tenantId, bypassRls: true },
      (tx) =>
        tx.get<{ id: string }>(
          'SELECT id FROM client_requests WHERE tenant_id = ? AND id = ? LIMIT 1',
          tenantId,
          'demo_creq-201'
        )
    );
    if (existing) return;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const twoHoursAgo = new Date(nowMs - 2 * 3600 * 1000).toISOString();
    const oneDayAgo = new Date(nowMs - 24 * 3600 * 1000).toISOString();
    const threeDaysAhead = new Date(nowMs + 3 * 24 * 3600 * 1000).toISOString();
    const fiveDaysAhead = new Date(nowMs + 5 * 24 * 3600 * 1000).toISOString();

    await this.engineStore.db.withTenantTransaction(
      { tenantId, bypassRls: true },
      async (tx) => {
        await tx.run(
          `INSERT INTO client_requests
           (id, tenant_id, client_id, client_name, template_id, title, period, stage, expected_due_utc, approval_status, approved_by, approved_at_utc, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_creq-101',
          tenantId,
          'demo_cli-acme',
          'Acme Ltd',
          'demo_tpl-monthly-close',
          'Acme Ltd — Oct 2026 Monthly Close & Reconciliation',
          'Oct 2026',
          'Awaiting your approval',
          threeDaysAhead,
          oneDayAgo,
          twoHoursAgo
        );

        await tx.run(
          `INSERT INTO client_requests
           (id, tenant_id, client_id, client_name, template_id, title, period, stage, expected_due_utc, approval_status, approved_by, approved_at_utc, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_creq-102',
          tenantId,
          'demo_cli-acme',
          'Acme Ltd',
          'demo_tpl-payroll-tax',
          'Acme Ltd — Q3 2026 Payroll Tax Remittance Package',
          'Q3 2026',
          'In review',
          fiveDaysAhead,
          oneDayAgo,
          nowIso
        );

        // Confirmed milestones ONLY (never provisional/detected/suggested)
        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, withdrawn_at_utc, withdrawal_reason, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, NULL, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cmil-1',
          tenantId,
          'demo_cli-acme',
          'demo_creq-101',
          'Bank Statements & Clearing Ledger Verified',
          oneDayAgo,
          'Maya Patel (Senior Accountant)',
          oneDayAgo
        );

        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, withdrawn_at_utc, withdrawal_reason, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, NULL, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cmil-2',
          tenantId,
          'demo_cli-acme',
          'demo_creq-101',
          'Trial Balance Tie-Out Completed — Ready for Sign-off',
          twoHoursAgo,
          'Marcus Chen (Team Lead)',
          twoHoursAgo
        );

        // Withdrawn milestone example showing correction audit trail (PORT-2)
        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, withdrawn_at_utc, withdrawal_reason, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'withdrawn', ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cmil-3',
          tenantId,
          'demo_cli-acme',
          'demo_creq-102',
          'Preliminary Q3 Remittance Schedule Issued',
          oneDayAgo,
          'Marcus Chen (Team Lead)',
          twoHoursAgo,
          'Withdrawn pending revised municipal tax credit adjustment notice.',
          twoHoursAgo
        );

        await tx.run(
          `INSERT INTO client_document_requests
           (id, tenant_id, client_id, request_id, title, status, due_date_utc, reminder_sent_at_utc, uploaded_file_id, uploaded_file_name, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cdoc-1',
          tenantId,
          'demo_cli-acme',
          'demo_creq-102',
          'Signed Q3 Director Remittance Authorization Form (PDF)',
          threeDaysAhead,
          twoHoursAgo,
          twoHoursAgo
        );

        await tx.run(
          `INSERT INTO client_document_requests
           (id, tenant_id, client_id, request_id, title, status, due_date_utc, reminder_sent_at_utc, uploaded_file_id, uploaded_file_name, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'verified', ?, NULL, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cdoc-2',
          tenantId,
          'demo_cli-acme',
          'demo_creq-101',
          'October Operating Chequing Bank Statement CSV',
          oneDayAgo,
          null,
          'Acme_Oct2026_BankStatement.csv',
          oneDayAgo
        );

        await tx.run(
          `INSERT INTO client_messages
           (id, tenant_id, client_id, request_id, sender_name, sender_role, body, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cmsg-1',
          tenantId,
          'demo_cli-acme',
          'demo_creq-101',
          'Marcus Chen (Team Lead)',
          'team_lead',
          'Your October bank reconciliation and supporting tie-out schedule are confirmed. Please review and approve when convenient.',
          twoHoursAgo
        );

        await tx.run(
          `INSERT INTO client_requests
           (id, tenant_id, client_id, client_name, template_id, title, period, stage, expected_due_utc, approval_status, approved_by, approved_at_utc, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_creq-201',
          tenantId,
          'demo_cli-northstar',
          'Northstar Logistics',
          'demo_tpl-payroll-tax',
          'Northstar Logistics — Q3 2026 Payroll Register Audit',
          'Q3 2026',
          'In review',
          threeDaysAhead,
          oneDayAgo,
          nowIso
        );

        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, withdrawn_at_utc, withdrawal_reason, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, NULL, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cmil-201',
          tenantId,
          'demo_cli-northstar',
          'demo_creq-201',
          'Q3 Gross-to-Net Payroll Deductions Verified',
          twoHoursAgo,
          'Hannah Kim (Tax Team Lead)',
          twoHoursAgo
        );

        await tx.run(
          `INSERT INTO client_requests
           (id, tenant_id, client_id, client_name, template_id, title, period, stage, expected_due_utc, approval_status, approved_by, approved_at_utc, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_creq-301',
          tenantId,
          'demo_cli-harbor',
          'Harbor Health',
          'demo_tpl-payroll-tax',
          'Harbor Health — FY25 Corporate Tax Return Draft',
          'FY25',
          'Documents received',
          fiveDaysAhead,
          oneDayAgo,
          nowIso
        );

        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, withdrawn_at_utc, withdrawal_reason, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, NULL, ?)
           ON CONFLICT (id) DO NOTHING`,
          'demo_cmil-301',
          tenantId,
          'demo_cli-harbor',
          'demo_creq-301',
          'FY25 Financial Statements & Trial Balance Intake Confirmed',
          oneDayAgo,
          'Elena Gomez (Remote Tax)',
          oneDayAgo
        );
      }
    );
  }

  public async getPortalOverview(params: {
    tenantId: string;
    viewerRole: UserRole;
    viewerClientId?: string | null;
    requestedClientId?: string | null;
  }) {
    await this.engineStore.ready();
    await this.ensureDemoPortalSeeded(params.tenantId);

    const branding: PortalBrandingConfig = await this.engineStore.getPortalBranding(params.tenantId);

    const clients = await this.engineStore.getClients(params.tenantId);
    const scopedClientId =
      params.viewerRole === 'client'
        ? params.viewerClientId || clients[0]?.id || 'demo_cli-acme'
        : params.requestedClientId || clients[0]?.id || 'demo_cli-acme';

    const matchedClient = clients.find((c) => c.id === scopedClientId) || null;
    const templates = (await this.engineStore.getTemplates(params.tenantId)).map(
      (t) => ({
        id: t.id,
        name: t.name,
        milestoneNames: t.steps.map((s) => s.title),
      })
    );

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const autoRemindWindowIso = new Date(nowMs + 48 * 3600 * 1000).toISOString();

    const { requests, milestones, documentRequests, messages } =
      await this.engineStore.db.withTenantTransaction(
        { tenantId: params.tenantId },
        async (tx) => {
          // Automatic reminders: mark any pending doc request due within 48h or overdue
          await tx.run(
            `UPDATE client_document_requests
             SET reminder_sent_at_utc = ?, updated_at_utc = ?
             WHERE tenant_id = ? AND client_id = ?
               AND status = 'pending'
               AND reminder_sent_at_utc IS NULL
               AND due_date_utc <= ?`,
            nowIso,
            nowIso,
            params.tenantId,
            scopedClientId,
            autoRemindWindowIso
          );

          const reqRows = await tx.all<any>(
            'SELECT * FROM client_requests WHERE tenant_id = ? AND client_id = ? ORDER BY updated_at_utc DESC',
            params.tenantId,
            scopedClientId
          );
          const milRows = await tx.all<any>(
            'SELECT * FROM client_milestones WHERE tenant_id = ? AND client_id = ? ORDER BY updated_at_utc DESC',
            params.tenantId,
            scopedClientId
          );
          const docRows = await tx.all<any>(
            'SELECT * FROM client_document_requests WHERE tenant_id = ? AND client_id = ? ORDER BY due_date_utc ASC',
            params.tenantId,
            scopedClientId
          );
          const msgRows = await tx.all<any>(
            'SELECT * FROM client_messages WHERE tenant_id = ? AND client_id = ? ORDER BY created_at_utc ASC',
            params.tenantId,
            scopedClientId
          );
          return {
            requests: reqRows,
            milestones: milRows,
            documentRequests: docRows,
            messages: msgRows,
          };
        }
      );

    const mappedRequests: ClientPortalRequest[] = requests.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      clientId: r.client_id,
      clientName: r.client_name,
      templateId: r.template_id || null,
      engineTaskId: r.engine_task_id || null,
      title: r.title,
      period: r.period,
      stage: r.stage as PortalRequestStage,
      expectedDueUtc: r.expected_due_utc,
      notes: r.notes || null,
      approvalStatus: r.approval_status === 'approved' ? 'approved' : 'pending',
      approvedBy: r.approved_by || null,
      signatureName: r.signature_name || r.approved_by || null,
      approvalNotes: r.approval_notes || null,
      approvedAtUtc: r.approved_at_utc || null,
      createdAtUtc: r.created_at_utc,
      updatedAtUtc: r.updated_at_utc,
    }));

    const mappedMilestones: ClientPortalMilestone[] = milestones
      .filter((m) => m.status === 'confirmed' || m.status === 'withdrawn')
      .map((m) => ({
        id: m.id,
        tenantId: m.tenant_id,
        clientId: m.client_id,
        requestId: m.request_id,
        title: m.title,
        status: m.status,
        confirmedAtUtc: m.confirmed_at_utc,
        confirmedBy: m.confirmed_by,
        withdrawnAtUtc: m.withdrawn_at_utc || null,
        withdrawalReason: m.withdrawal_reason || null,
        updatedAtUtc: m.updated_at_utc,
      }));

    const mappedDocRequests: ClientPortalDocumentRequest[] = documentRequests.map((d) => ({
      id: d.id,
      tenantId: d.tenant_id,
      clientId: d.client_id,
      requestId: d.request_id,
      title: d.title,
      status: d.status,
      dueDateUtc: d.due_date_utc,
      reminderSentAtUtc: d.reminder_sent_at_utc || null,
      isOverdue: d.status === 'pending' && new Date(d.due_date_utc).getTime() < nowMs,
      uploadedFileId: d.uploaded_file_id || null,
      uploadedFileName: d.uploaded_file_name || null,
      updatedAtUtc: d.updated_at_utc,
    }));

    const mappedMessages: ClientPortalMessage[] = messages.map((m) => ({
      id: m.id,
      tenantId: m.tenant_id,
      clientId: m.client_id,
      requestId: m.request_id,
      senderName: m.sender_name,
      senderRole: m.sender_role as UserRole,
      body: m.body,
      createdAtUtc: m.created_at_utc,
    }));

    return {
      lastUpdatedUtc: nowIso,
      firmName: branding.firmName,
      branding,
      clientId: scopedClientId,
      clientName: matchedClient?.legalName || mappedRequests[0]?.clientName || 'Client Account',
      availableClients:
        params.viewerRole === 'client'
          ? []
          : clients.map((c) => ({ id: c.id, legalName: c.legalName })),
      templates,
      requests: mappedRequests,
      milestones: mappedMilestones,
      documentRequests: mappedDocRequests,
      messages: mappedMessages,
    };
  }

  public async createPortalRequest(params: {
    tenantId: string;
    clientId: string;
    title: string;
    period: string;
    templateId?: string | null;
    expectedDueUtc?: string;
    notes?: string;
    requesterName: string;
  }): Promise<ClientPortalRequest> {
    await this.engineStore.ready();
    const clients = await this.engineStore.getClients(params.tenantId);
    const client = clients.find((c) => c.id === params.clientId);
    const clientName = client?.legalName || 'Client Account';
    const templates = await this.engineStore.getTemplates(params.tenantId);
    const selectedTemplate =
      (params.templateId && templates.find((t) => t.id === params.templateId)) ||
      templates[0] ||
      null;
    const staffList = await this.engineStore.listShiftUsers(params.tenantId);
    const assignee =
      staffList.find((u) => u.role === 'team_lead') ||
      staffList.find((u) => u.role === 'accountant') ||
      staffList[0];

    const nowIso = new Date().toISOString();
    const id = `creq-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const expectedDueUtc =
      params.expectedDueUtc ||
      new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // Create a linked firm task from the selected template so accounting teams pick it up immediately
    const createdTask = await this.engineStore.createEngineTask({
      tenantId: params.tenantId,
      clientId: params.clientId,
      clientName,
      templateId: selectedTemplate?.id || params.templateId || undefined,
      title: `${clientName} — ${params.title}`,
      period: params.period,
      status: 'todo',
      dueDateUtc: expectedDueUtc,
      assignedUserId: assignee?.userId || 'demo_u_acc_01',
      estimatedMinutes: Math.max(90, (selectedTemplate?.steps.length || 2) * 60),
    });

    await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        await tx.run(
          `INSERT INTO client_requests
           (id, tenant_id, client_id, client_name, template_id, engine_task_id, title, period, stage, expected_due_utc, notes, approval_status, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Documents received', ?, ?, 'pending', ?, ?)`,
          id,
          params.tenantId,
          params.clientId,
          clientName,
          selectedTemplate?.id || params.templateId || null,
          createdTask.id,
          params.title,
          params.period,
          expectedDueUtc,
          params.notes?.trim() || null,
          nowIso,
          nowIso
        );

        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
          `cmil-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
          params.tenantId,
          params.clientId,
          id,
          `Request Submitted & Task Queued (${selectedTemplate?.name || 'Custom'})`,
          nowIso,
          params.requesterName,
          nowIso
        );

        // Auto-create initial document requests derived from the template steps
        const docDueIso = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
        const docTitles =
          selectedTemplate && selectedTemplate.steps.length > 0
            ? selectedTemplate.steps
                .slice(0, 2)
                .map((s) => s.docTypeHint || `Supporting File: ${s.title}`)
            : [`Supporting Statements & Source Documents (${params.period})`];

        for (const docTitle of docTitles) {
          await tx.run(
            `INSERT INTO client_document_requests
             (id, tenant_id, client_id, request_id, title, status, due_date_utc, reminder_sent_at_utc, uploaded_file_id, uploaded_file_name, updated_at_utc)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
            `cdoc-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            params.tenantId,
            params.clientId,
            id,
            docTitle,
            docDueIso,
            nowIso
          );
        }
      }
    );

    return {
      id,
      tenantId: params.tenantId,
      clientId: params.clientId,
      clientName,
      templateId: selectedTemplate?.id || params.templateId || null,
      engineTaskId: createdTask.id,
      title: params.title,
      period: params.period,
      stage: 'Documents received',
      expectedDueUtc,
      notes: params.notes?.trim() || null,
      approvalStatus: 'pending',
      approvedBy: null,
      signatureName: null,
      approvalNotes: null,
      approvedAtUtc: null,
      createdAtUtc: nowIso,
      updatedAtUtc: nowIso,
    };
  }

  public async approvePortalRequest(params: {
    tenantId: string;
    requestId: string;
    scopedClientId?: string | null;
    approverName: string;
    signatureName?: string;
    approvalNotes?: string;
  }) {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();
    const resolvedSignature = params.signatureName?.trim() || params.approverName;

    const updated = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<any>(
          'SELECT * FROM client_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.requestId
        );
        if (!row) {
          throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Client request not found.');
        }
        if (params.scopedClientId && row.client_id !== params.scopedClientId) {
          throw new HttpError(403, 'FORBIDDEN', 'Cannot approve a request for another client.');
        }

        await tx.run(
          `UPDATE client_requests
           SET approval_status = 'approved',
               stage = 'Complete',
               approved_by = ?,
               signature_name = ?,
               approval_notes = ?,
               approved_at_utc = ?,
               updated_at_utc = ?
           WHERE tenant_id = ? AND id = ?`,
          params.approverName,
          resolvedSignature,
          params.approvalNotes?.trim() || null,
          nowIso,
          nowIso,
          params.tenantId,
          params.requestId
        );

        if (row.engine_task_id) {
          await tx.run(
            `UPDATE engine_tasks
             SET status = 'completed', version = version + 1, updated_at_utc = ?
             WHERE tenant_id = ? AND id = ?`,
            nowIso,
            params.tenantId,
            row.engine_task_id
          );
        }

        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
          `cmil-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
          params.tenantId,
          row.client_id,
          row.id,
          `Client Approval & Electronic Sign-Off (${resolvedSignature})`,
          nowIso,
          params.approverName,
          nowIso
        );

        return row;
      }
    );

    return {
      requestId: updated.id,
      clientId: updated.client_id as string,
      signatureName: resolvedSignature,
      approvedAtUtc: nowIso,
    };
  }

  public async postPortalMessage(params: {
    tenantId: string;
    requestId: string;
    scopedClientId?: string | null;
    senderName: string;
    senderRole: UserRole;
    body: string;
  }): Promise<ClientPortalMessage> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();
    const id = `cmsg-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<any>(
          'SELECT client_id FROM client_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.requestId
        );
        if (!row) {
          throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Client request not found.');
        }
        if (params.scopedClientId && row.client_id !== params.scopedClientId) {
          throw new HttpError(403, 'FORBIDDEN', 'Cannot post message on another client request.');
        }

        await tx.run(
          `INSERT INTO client_messages
           (id, tenant_id, client_id, request_id, sender_name, sender_role, body, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          params.tenantId,
          row.client_id,
          params.requestId,
          params.senderName,
          params.senderRole,
          params.body,
          nowIso
        );

        await tx.run(
          'UPDATE client_requests SET updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
          nowIso,
          params.tenantId,
          params.requestId
        );
        return row.client_id as string;
      }
    );

    return {
      id,
      tenantId: params.tenantId,
      clientId,
      requestId: params.requestId,
      senderName: params.senderName,
      senderRole: params.senderRole,
      body: params.body,
      createdAtUtc: nowIso,
    };
  }

  public async assertDocumentRequestUploadAccess(params: {
    tenantId: string;
    docReqId: string;
    scopedClientId?: string | null;
  }): Promise<string> {
    await this.engineStore.ready();
    await this.ensureDemoPortalSeeded(params.tenantId);
    return this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<any>(
          'SELECT client_id FROM client_document_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.docReqId
        );
        if (!row) {
          throw new HttpError(404, 'DOC_REQ_NOT_FOUND', 'Document request not found.');
        }
        if (params.scopedClientId && row.client_id !== params.scopedClientId) {
          throw new HttpError(403, 'FORBIDDEN', 'Cannot upload to another client document request.');
        }
        return row.client_id as string;
      }
    );
  }

  public async attachDocumentUpload(params: {
    tenantId: string;
    docReqId: string;
    scopedClientId?: string | null;
    fileId: string;
    fileName: string;
  }) {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<any>(
          'SELECT client_id FROM client_document_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.docReqId
        );
        if (!row) {
          throw new HttpError(404, 'DOC_REQ_NOT_FOUND', 'Document request not found.');
        }
        if (params.scopedClientId && row.client_id !== params.scopedClientId) {
          throw new HttpError(403, 'FORBIDDEN', 'Cannot upload to another client document request.');
        }

        await tx.run(
          `UPDATE client_document_requests
           SET status = 'uploaded',
               uploaded_file_id = ?,
               uploaded_file_name = ?,
               updated_at_utc = ?
           WHERE tenant_id = ? AND id = ?`,
          params.fileId,
          params.fileName,
          nowIso,
          params.tenantId,
          params.docReqId
        );
        return row.client_id as string;
      }
    );

    return { docReqId: params.docReqId, clientId, updatedAtUtc: nowIso };
  }

  public async confirmMilestone(params: {
    tenantId: string;
    requestId: string;
    title: string;
    confirmedBy: string;
  }): Promise<ClientPortalMilestone> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();
    const id = `cmil-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const req = await tx.get<{ client_id: string }>(
          'SELECT client_id FROM client_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.requestId
        );
        if (!req) {
          throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Client request not found.');
        }
        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
          id,
          params.tenantId,
          req.client_id,
          params.requestId,
          params.title,
          nowIso,
          params.confirmedBy,
          nowIso
        );
        return req.client_id;
      }
    );

    return {
      id,
      tenantId: params.tenantId,
      clientId,
      requestId: params.requestId,
      title: params.title,
      status: 'confirmed',
      confirmedAtUtc: nowIso,
      confirmedBy: params.confirmedBy,
      withdrawnAtUtc: null,
      withdrawalReason: null,
      updatedAtUtc: nowIso,
    };
  }

  public async withdrawMilestone(params: {
    tenantId: string;
    milestoneId: string;
    reason: string;
  }): Promise<{ milestoneId: string; clientId: string; withdrawnAtUtc: string }> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<{ client_id: string }>(
          'SELECT client_id FROM client_milestones WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.milestoneId
        );
        if (!row) {
          throw new HttpError(404, 'MILESTONE_NOT_FOUND', 'Milestone not found.');
        }
        await tx.run(
          `UPDATE client_milestones
           SET status = 'withdrawn',
               withdrawn_at_utc = ?,
               withdrawal_reason = ?,
               updated_at_utc = ?
           WHERE tenant_id = ? AND id = ?`,
          nowIso,
          params.reason,
          nowIso,
          params.tenantId,
          params.milestoneId
        );
        return row.client_id;
      }
    );

    return { milestoneId: params.milestoneId, clientId, withdrawnAtUtc: nowIso };
  }

  public async updateRequestStage(params: {
    tenantId: string;
    requestId: string;
    stage: PortalRequestStage;
  }): Promise<{ requestId: string; clientId: string; stage: PortalRequestStage; updatedAtUtc: string }> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<any>(
          'SELECT client_id, engine_task_id FROM client_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.requestId
        );
        if (!row) {
          throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Client request not found.');
        }

        await tx.run(
          'UPDATE client_requests SET stage = ?, updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
          params.stage,
          nowIso,
          params.tenantId,
          params.requestId
        );

        if (row.engine_task_id) {
          const nextTaskStatus =
            params.stage === 'Complete'
              ? 'completed'
              : params.stage === 'Documents received'
              ? 'todo'
              : 'in_progress';
          await tx.run(
            'UPDATE engine_tasks SET status = ?, version = version + 1, updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
            nextTaskStatus,
            nowIso,
            params.tenantId,
            row.engine_task_id
          );
        }

        return row.client_id as string;
      }
    );

    return {
      requestId: params.requestId,
      clientId,
      stage: params.stage,
      updatedAtUtc: nowIso,
    };
  }

  public async createDocumentRequest(params: {
    tenantId: string;
    requestId: string;
    title: string;
    dueDateUtc?: string;
  }): Promise<ClientPortalDocumentRequest> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();
    const dueIso = params.dueDateUtc || new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const id = `cdoc-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const req = await tx.get<{ client_id: string }>(
          'SELECT client_id FROM client_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.requestId
        );
        if (!req) {
          throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Client request not found.');
        }

        await tx.run(
          `INSERT INTO client_document_requests
           (id, tenant_id, client_id, request_id, title, status, due_date_utc, reminder_sent_at_utc, uploaded_file_id, uploaded_file_name, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
          id,
          params.tenantId,
          req.client_id,
          params.requestId,
          params.title,
          dueIso,
          nowIso
        );
        return req.client_id;
      }
    );

    return {
      id,
      tenantId: params.tenantId,
      clientId,
      requestId: params.requestId,
      title: params.title,
      status: 'pending',
      dueDateUtc: dueIso,
      reminderSentAtUtc: null,
      isOverdue: new Date(dueIso).getTime() < Date.now(),
      uploadedFileId: null,
      uploadedFileName: null,
      updatedAtUtc: nowIso,
    };
  }

  public async sendDocumentReminder(params: {
    tenantId: string;
    docReqId: string;
  }): Promise<{ docReqId: string; clientId: string; reminderSentAtUtc: string }> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<{ client_id: string }>(
          'SELECT client_id FROM client_document_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.docReqId
        );
        if (!row) {
          throw new HttpError(404, 'DOC_REQ_NOT_FOUND', 'Document request not found.');
        }

        await tx.run(
          'UPDATE client_document_requests SET reminder_sent_at_utc = ?, updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
          nowIso,
          nowIso,
          params.tenantId,
          params.docReqId
        );
        return row.client_id;
      }
    );

    return { docReqId: params.docReqId, clientId, reminderSentAtUtc: nowIso };
  }

  public async verifyDocumentUpload(params: {
    tenantId: string;
    docReqId: string;
    verifiedBy: string;
  }): Promise<{ docReqId: string; clientId: string; status: 'verified'; updatedAtUtc: string }> {
    await this.engineStore.ready();
    const nowIso = new Date().toISOString();

    const clientId = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      async (tx) => {
        const row = await tx.get<{ client_id: string; request_id: string; title: string }>(
          'SELECT client_id, request_id, title FROM client_document_requests WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.docReqId
        );
        if (!row) {
          throw new HttpError(404, 'DOC_REQ_NOT_FOUND', 'Document request not found.');
        }

        await tx.run(
          `UPDATE client_document_requests
           SET status = 'verified', updated_at_utc = ?
           WHERE tenant_id = ? AND id = ?`,
          nowIso,
          params.tenantId,
          params.docReqId
        );

        await tx.run(
          `INSERT INTO client_milestones
           (id, tenant_id, client_id, request_id, title, status, confirmed_at_utc, confirmed_by, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
          `cmil-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
          params.tenantId,
          row.client_id,
          row.request_id,
          `Document Verified: ${row.title}`,
          nowIso,
          params.verifiedBy,
          nowIso
        );

        return row.client_id;
      }
    );

    return { docReqId: params.docReqId, clientId, status: 'verified', updatedAtUtc: nowIso };
  }

  public async verifyPortalFileAccess(params: {
    tenantId: string;
    fileId: string;
    scopedClientId?: string | null;
  }): Promise<boolean> {
    await this.engineStore.ready();
    if (!params.scopedClientId) return true;
    const row = await this.engineStore.db.withTenantTransaction(
      { tenantId: params.tenantId },
      (tx) =>
        tx.get<{ client_id: string }>(
          'SELECT client_id FROM client_document_requests WHERE tenant_id = ? AND uploaded_file_id = ? LIMIT 1',
          params.tenantId,
          params.fileId
        )
    );
    return Boolean(row && row.client_id === params.scopedClientId);
  }
}
