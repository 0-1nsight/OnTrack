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
  affectedUserIds?: string[];
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
  const isSelf =
    sub.userId === msg.affectedUserId ||
    Boolean(msg.affectedUserIds?.includes(sub.userId));

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
    if (msg.meta?.broadcastTenantBranding === true) {
      return true;
    }
    if (!msg.affectedClientId) {
      return false;
    }
    if (sub.clientId && msg.affectedClientId !== sub.clientId) {
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
    if (isSelf) {
      return true;
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
  private pgNotifyReady = false;
  private pgKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pgReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pgReconnectAttempt = 0;
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

  private clearPgTimers() {
    if (this.pgKeepaliveTimer) {
      clearInterval(this.pgKeepaliveTimer);
      this.pgKeepaliveTimer = null;
    }
    if (this.pgReconnectTimer) {
      clearTimeout(this.pgReconnectTimer);
      this.pgReconnectTimer = null;
    }
  }

  private schedulePgReconnect() {
    if (this.closing || this.pgReconnectTimer) return;
    const delayMs = Math.min(30_000, 2_000 * Math.pow(2, this.pgReconnectAttempt));
    this.pgReconnectAttempt = Math.min(this.pgReconnectAttempt + 1, 4);
    this.pgReconnectTimer = setTimeout(() => {
      this.pgReconnectTimer = null;
      void this.initPgListenNotify();
    }, delayMs);
    this.pgReconnectTimer.unref();
  }

  private cleanupDeadPgClient(client: PgClient) {
    if (this.pgNotifyClient === client) {
      this.pgNotifyClient = null;
      this.pgNotifyReady = false;
    }
    if (this.pgKeepaliveTimer) {
      clearInterval(this.pgKeepaliveTimer);
      this.pgKeepaliveTimer = null;
    }
    client.removeAllListeners();
    client.end().catch(() => undefined);
  }

  private async initPgListenNotify() {
    if (this.closing || this.engineStore.db.dialect !== 'postgres') {
      return;
    }
    const sqlConn = appConfig.sqlConnection;
    if (!sqlConn && !appConfig.databaseUrl) {
      return;
    }
    const sslMode = (process.env.DATABASE_SSL || '').trim().toLowerCase();
    const ssl =
      sslMode === 'true' || sslMode === 'require'
        ? { rejectUnauthorized: true }
        : sslMode === 'no-verify' || sslMode === 'allow-self-signed'
          ? { rejectUnauthorized: false }
          : undefined;

    const client = sqlConn
      ? new PgClient({
          host: sqlConn.host,
          user: sqlConn.user,
          password: sqlConn.password,
          database: sqlConn.database,
          keepAlive: true,
          keepAliveInitialDelayMillis: 15_000,
          connectionTimeoutMillis: 15_000,
        })
      : new PgClient({
          connectionString: appConfig.databaseUrl,
          keepAlive: true,
          keepAliveInitialDelayMillis: 15_000,
          connectionTimeoutMillis: 15_000,
          ...(ssl ? { ssl } : {}),
        });

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
      if (this.closing) return;
      logger.debug('ws.pg_notify_reconnecting', { message: err.message });
      this.cleanupDeadPgClient(client);
      this.schedulePgReconnect();
    });

    client.on('end', () => {
      if (this.closing) return;
      this.cleanupDeadPgClient(client);
      this.schedulePgReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);
      if (this.closing) {
        await client.end().catch(() => undefined);
        return;
      }
      this.pgNotifyClient = client;
      this.pgNotifyReady = true;
      this.pgReconnectAttempt = 0;

      this.pgKeepaliveTimer = setInterval(() => {
        if (this.closing || this.pgNotifyClient !== client) return;
        void client.query('SELECT 1').catch(() => {
          if (this.closing) return;
          this.cleanupDeadPgClient(client);
          this.schedulePgReconnect();
        });
      }, 45_000);
      this.pgKeepaliveTimer.unref();

      logger.info('ws.pg_listen_ready', { channel: PG_NOTIFY_CHANNEL });
    } catch (err: any) {
      this.cleanupDeadPgClient(client);
      if (this.pgReconnectAttempt >= 2) {
        logger.warn('ws.pg_listen_fallback_local', { message: err?.message });
      } else {
        logger.debug('ws.pg_listen_retry', { message: err?.message });
      }
      this.schedulePgReconnect();
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
            mustSetPassword: false,
            deviceId: verified.deviceId,
            isDemoSandbox: verified.tenantId === 'firm_demo',
          };
        } else if (cookies[SESSION_COOKIE_NAME]) {
          const ses = await this.authStore.verifySessionToken(cookies[SESSION_COOKIE_NAME]);
          if (ses) {
            if (!ses.mfaVerified || ses.mustSetPassword) {
              ws.close(4403, 'Onboarding and MFA verification required');
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
              : demoRole === 'line_manager'
              ? 'demo_u_mgr_01'
              : demoRole === 'executive'
              ? 'demo_u_exec_01'
              : demoRole === 'admin_it'
              ? 'demo_u_admin_01'
              : demoRole === 'client'
              ? 'demo_u_client_01'
              : 'demo_u_acc_01';

          const demoClientId =
            demoRole !== 'client'
              ? null
              : demoUser === 'demo_u_client_02'
              ? 'demo_cli-northstar'
              : demoUser === 'demo_u_client_03'
              ? 'demo_cli-harbor'
              : 'demo_cli-acme';

          authCtx = {
            mode: 'demo',
            principalType: 'demo',
            tenantId: 'firm_demo',
            userId: demoUser,
            userEmail: 'demo@apex-cpa.example',
            userName: 'Demo Preview User',
            role: demoRole,
            teamId: 'team_audit',
            clientId: demoClientId,
            canDrilldownTimeline: demoRole === 'team_lead',
            mfaVerified: true,
            mustEnrollMfa: false,
            mustSetPassword: false,
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
    if (this.pgNotifyReady && this.pgNotifyClient) {
      const pgPool = await this.engineStore.db.getPgPool();
      if (pgPool) {
        try {
          await pgPool.query('SELECT pg_notify($1, $2)', [
            PG_NOTIFY_CHANNEL,
            JSON.stringify(msg),
          ]);
          return;
        } catch (err: any) {
          logger.debug('ws.pg_notify_publish_fallback', { message: err?.message });
        }
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
    this.clearPgTimers();
    for (const sub of this.subscribers) {
      sub.ws.close(1001, 'Server shutting down');
    }
    this.subscribers.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.pgNotifyClient) {
      const client = this.pgNotifyClient;
      this.pgNotifyClient = null;
      this.pgNotifyReady = false;
      client.removeAllListeners();
      await client.end().catch(() => undefined);
    }
  }
}
