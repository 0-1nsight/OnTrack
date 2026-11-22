import nodemailer from 'nodemailer';
import { appConfig } from './config.ts';
import { logger } from './logger.ts';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  meta?: {
    kind: 'invite' | 'password_reset' | 'it_alert' | 'portal_notice';
    actionUrl?: string;
  };
}

export interface RecordedDevEmail {
  to: string;
  subject: string;
  kind: string;
  actionUrl?: string;
  sentAtUtc: string;
}

const devOutbox: RecordedDevEmail[] = [];

export function getDevEmailOutbox(): RecordedDevEmail[] {
  return [...devOutbox];
}

export function clearDevEmailOutbox(): void {
  devOutbox.length = 0;
}

export async function sendMail(msg: OutboundEmail): Promise<{ delivered: boolean }> {
  if (!appConfig.smtp.enabled) {
    devOutbox.push({
      to: msg.to,
      subject: msg.subject,
      kind: msg.meta?.kind || 'system',
      actionUrl: msg.meta?.actionUrl,
      sentAtUtc: new Date().toISOString(),
    });
    if (devOutbox.length > 100) devOutbox.shift();

    logger.info('mailer.dev_preview', {
      to: msg.to,
      subject: msg.subject,
      kind: msg.meta?.kind || 'system',
    });
    return { delivered: false };
  }

  const transporter = nodemailer.createTransport({
    host: appConfig.smtp.host,
    port: appConfig.smtp.port,
    secure: appConfig.smtp.secure,
    auth:
      appConfig.smtp.user && appConfig.smtp.pass
        ? { user: appConfig.smtp.user, pass: appConfig.smtp.pass }
        : undefined,
  });

  await transporter.sendMail({
    from: appConfig.smtp.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });

  logger.info('mailer.sent', {
    to: msg.to,
    subject: msg.subject,
    kind: msg.meta?.kind || 'system',
  });
  return { delivered: true };
}
