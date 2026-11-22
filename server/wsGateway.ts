import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Client as PgClient } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import { UserRole } from '../src/engine/types.ts';
import {
  extractBearerToken,
  parseCookieHeader,
  RequestAuthContext,
  SESSION_COOKIE_NAME,
} from './auth.ts';
import { AuthStore } from './authStore.ts';
import { appConfig } from './config.ts';
import { EngineSQLStore } from './engineStore.ts';
import { logger } from './logger.ts';

export type WsEngineEventType =
  | 'state:updated'
  | 'activity:updated'
  | 'freshness:updated'
  | 'portal:updated';

export interface EngineSubscriber {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  role: UserRole;
  teamId: string;
  clientId?: string | null;
  sessionId?: string;
}

export interface EngineBroadcastMessage {
  tenantId: string;
  affectedUserId: string;
  affectedTeamId?: string | null;
  affectedClientId?: string | null;
  eventType: WsEngineEventType;
  meta?: Record<string, unknown>;
}

const PG_NOTIFY_CHANNEL = 'ontrack_engine_events';

/**
 * Pure visibility predicate for WebSocket pushes (VIS-1).
 * Never emits raw activity updates to executive, line_manager, client, or admin_it,
 * and scopes accountants strictly to self.
 */
export function isSubscriberPermittedForEvent(
  sub: Pick<EngineSubscriber, 'tenantId' | 'userId' | 'role' | 'teamId' | 'clientId'>,
  msg: EngineBroadcastMessage
): boolean {
  if (sub.tenantId !== msg.tenantId) return false;
  const isSelf = sub.userId === msg.affectedUserId;

  if (sub.role === 'accountant') {
    return isSelf;
  }

  if (sub.role === 'client') {
    if (msg.eventType !== 'portal:updated' && msg.eventType !== 'state:updated') {
      return false;
    }
    if (msg.eventType === 'state:updated' && msg.meta?.portalVisible !== true) {
      return false;
    }
    if (msg.affectedClientId && sub.clientId && msg.affectedClientId !== sub.clientId) {
      return false;
    }
    return true;
  }

  if (sub.role === 'admin_it') {
    return msg.eventType === 'freshness:updated' || msg.eventType === 'state:updated';
  }

  if (sub.role === 'executive') {
    return msg.eventType !== 'activity:updated';
  }

  if (sub.role === 'line_manager') {
    return msg.eventType !== 'activity:updated';
  }

  if (sub.role === 'team_lead') {
    if (msg.eventType === 'activity:updated') {
      return isSelf;
    }
    if (msg.affectedTeamId && sub.teamId && msg.affectedTeamId !== sub.teamId) {
      return false;
    }
    return true;
  }

  return false;
}

export class EngineWsGateway {
  private readonly subscribers = new Set<EngineSubscriber>();
  private readonly wss: WebSocketServer;
  private pgNotifyClient: PgClient | null = null;
  private closing = false;

  constructor(
    server: http.Server,
    private readonly engineStore: EngineSQLStore,
    private readonly authStore: AuthStore
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws/engine' });
    this.setupConnectionHandler();
    void this.initPgListenNotify();
  }

  private async initPgListenNotify() {
    if (this.engineStore.db.dialect !== 'postgres' || !appConfig.databaseUrl) {
      return;
    }
    try {
      const client = new PgClient({ connectionString: appConfig.databaseUrl });
      await client.connect();
      await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);
      client.on('notification', (n) => {
        if (n.channel !== PG_NOTIFY_CHANNEL || !n.payload) return;
        try {
          const msg = JSON.parse(n.payload) as EngineBroadcastMessage;
          this.deliverLocally(msg);
        } catch {
          // ignore malformed notify payload
        }
      });
      client.on('error', (err) => {
        logger.warn('ws.pg_notify_error', { message: err.message });
      });
      this.pgNotifyClient = client;
      logger.info('ws.pg_listen_ready', { channel: PG_NOTIFY_CHANNEL });
    } catch (err: any) {
      logger.warn('ws.pg_listen_fallback_local', { message: err?.message });
    }
  }

  private setupConnectionHandler() {
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url || '/ws/engine', 'http://localhost:3000');
      const cookies = parseCookieHeader(req.headers.cookie);
      const bearer = extractBearerToken(req.headers.authorization);
      const queryToken = url.searchParams.get('token');
      const requestedTenantId = url.searchParams.get('tenantId') || undefined;
      const previewRole = url.searchParams.get('previewRole') || url.searchParams.get('role');
      const previewUserId =
        url.searchParams.get('previewUserId') || url.searchParams.get('userId');

      let authCtx: RequestAuthContext | null = null;

      try {
        const deviceToken =
          bearer?.startsWith('ontrack_dev_')
            ? bearer
            : queryToken?.startsWith('ontrack_dev_')
            ? queryToken
            : null;

        if (deviceToken) {
          const verified = await this.engineStore.verifyDeviceToken(deviceToken);
          if (!verified) {
            ws.close(4401, 'Invalid or revoked device pairing token');
            return;
          }
          authCtx = {
            mode: 'device',
            principalType: 'device',
            tenantId: verified.tenantId,
            userId: verified.userId,
            userEmail: verified.email,
            userName: verified.userName,
            role: verified.role,
            teamId: verified.teamId,
            canDrilldownTimeline: false,
            mfaVerified: true,
            mustEnrollMfa: false,
            deviceId: verified.deviceId,
            isDemoSandbox: verified.tenantId === 'firm_demo',
          };
        } else if (cookies[SESSION_COOKIE_NAME]) {
          const ses = await this.authStore.verifySessionToken(cookies[SESSION_COOKIE_NAME]);
          if (ses) {
            if (!ses.mfaVerified) {
              ws.close(4403, 'MFA verification required');
              return;
            }
            authCtx = ses;
          }
        }

        if (!authCtx && appConfig.demoModeEnabled && requestedTenantId === 'firm_demo') {
          const validRoles: UserRole[] = [
            'accountant',
            'team_lead',
            'line_manager',
            'executive',
            'client',
            'admin_it',
          ];
          const demoRole: UserRole =
            typeof previewRole === 'string' && validRoles.includes(previewRole as UserRole)
              ? (previewRole as UserRole)
              : 'accountant';
          const demoUser =
            typeof previewUserId === 'string' && previewUserId.startsWith('demo_')
              ? previewUserId
              : demoRole === 'team_lead'
              ? 'demo_u_lead_01'
              : demoRole === 'admin_it'
              ? 'demo_u_admin_01'
              : 'demo_u_acc_01';

          authCtx = {
            mode: 'demo',
            principalType: 'demo',
            tenantId: 'firm_demo',
            userId: demoUser,
            userEmail: 'demo@apex-cpa.example',
            userName: 'Demo Preview User',
            role: demoRole,
            teamId: 'team_audit',
            clientId: demoRole === 'client' ? 'demo_cli-acme' : null,
            canDrilldownTimeline: demoRole === 'team_lead',
            mfaVerified: true,
            mustEnrollMfa: false,
            isDemoSandbox: true,
          };
        }

        if (!authCtx) {
          ws.close(4401, 'Authentication required');
          return;
        }
      } catch {
        ws.close(4401, 'Unauthorized WebSocket connection');
        return;
      }

      const sub: EngineSubscriber = {
        ws,
        tenantId: authCtx.tenantId,
        userId: authCtx.userId,
        role: authCtx.role,
        teamId: authCtx.teamId,
        clientId: authCtx.clientId,
        sessionId: authCtx.sessionId,
      };
      this.subscribers.add(sub);

      ws.send(
        JSON.stringify({
          channel: 'engine',
          type: 'connected',
          serverTimeUtc: new Date().toISOString(),
          tenantId: authCtx.tenantId,
          userId: authCtx.userId,
          role: authCtx.role,
          authMode: authCtx.mode,
        })
      );

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'sync:batch' && Array.isArray(msg.events)) {
            const t0 = performance.now();
            const targetUserId =
              authCtx!.mode === 'device'
                ? authCtx!.userId
                : authCtx!.isDemoSandbox && typeof msg.userId === 'string'
                ? msg.userId
                : authCtx!.userId;

            const result = await this.engineStore.ingestEventBatch({
              tenantId: authCtx!.tenantId,
              userId: targetUserId,
              deviceId: authCtx!.deviceId || String(msg.deviceId || 'dev-web-client'),
              events: msg.events,
            });
            this.engineStore.recordBroadcastLatency(performance.now() - t0);

            ws.send(JSON.stringify({ type: 'sync:ack', ...result }));
            if (result.stateChanged) {
              await this.publish({
                tenantId: authCtx!.tenantId,
                affectedUserId: targetUserId,
                affectedTeamId: authCtx!.teamId,
                eventType: 'state:updated',
                meta: {
                  lastAckSeq: result.lastAckSeq,
                  lateBacklogUpdated: result.lateBacklogUpdated,
                },
              });
            } else if (result.acceptedCount > 0) {
              await this.publish({
                tenantId: authCtx!.tenantId,
                affectedUserId: targetUserId,
                affectedTeamId: authCtx!.teamId,
                eventType: 'activity:updated',
                meta: {
                  lastAckSeq: result.lastAckSeq,
                },
              });
            }
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', serverTimeUtc: new Date().toISOString() }));
          }
        } catch {
          // Ignore malformed WS message
        }
      });

      ws.on('close', () => {
        this.subscribers.delete(sub);
      });
    });
  }

  private deliverLocally(msg: EngineBroadcastMessage) {
    const startedMs = performance.now();
    const sentAt = new Date().toISOString();
    let sentCount = 0;

    for (const sub of this.subscribers) {
      if (sub.ws.readyState !== WebSocket.OPEN) continue;
      if (!isSubscriberPermittedForEvent(sub, msg)) continue;

      sub.ws.send(
        JSON.stringify({
          channel: 'engine',
          type: msg.eventType,
          tenantId: msg.tenantId,
          affectedUserId: msg.affectedUserId,
          sentAtUtc: sentAt,
          ...(msg.meta || {}),
        })
      );
      sentCount++;
    }

    if (sentCount > 0) {
      this.engineStore.recordBroadcastLatency(performance.now() - startedMs);
    }
  }

  public async publish(msg: EngineBroadcastMessage): Promise<void> {
    if (this.pgNotifyClient) {
      try {
        await this.pgNotifyClient.query('SELECT pg_notify($1, $2)', [
          PG_NOTIFY_CHANNEL,
          JSON.stringify(msg),
        ]);
        return;
      } catch (err: any) {
        logger.warn('ws.pg_notify_publish_failed', { message: err?.message });
      }
    }
    this.deliverLocally(msg);
  }

  public disconnectSession(sessionId: string) {
    for (const sub of this.subscribers) {
      if (sub.sessionId === sessionId) {
        sub.ws.close(4401, 'Session revoked');
        this.subscribers.delete(sub);
      }
    }
  }

  public getActiveConnectionCount(): number {
    return this.subscribers.size;
  }

  public async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const sub of this.subscribers) {
      sub.ws.close(1001, 'Server shutting down');
    }
    this.subscribers.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.pgNotifyClient) {
      await this.pgNotifyClient.end().catch(() => undefined);
      this.pgNotifyClient = null;
    }
  }
}
