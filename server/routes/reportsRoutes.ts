import { GoogleGenAI, Type } from '@google/genai';
import { Router } from 'express';
import { z } from 'zod';
import { AuthStore } from '../authStore.ts';
import { appConfig } from '../config.ts';
import { EngineSQLStore } from '../engineStore.ts';
import { asyncHandler, HttpError } from '../errors.ts';
import { resolveHttpAuthContext } from './authMiddleware.ts';

/**
 * Strictly aggregate numeric-only payload.
 * Using `.strict()` rejects any request attempting to pass task titles, notes,
 * app names, file names, or raw activity blocks.
 */
const AggregateReportRequestSchema = z
  .object({
    weekStartDate: z.string().trim().min(4).max(32),
    weekEndDate: z.string().trim().min(4).max(32),
    tone: z.enum(['executive', 'standup', 'client']).default('executive'),
    metrics: z
      .object({
        totalHours: z.number().min(0).max(10000),
        totalMinutes: z.number().min(0).max(600000),
        plannedHours: z.number().min(0).max(10000),
        deepWorkPercent: z.number().min(0).max(100),
        billablePercent: z.number().min(0).max(100),
        completedCount: z.number().int().min(0).max(10000),
        totalTasksCount: z.number().int().min(0).max(10000),
        activeStaffCount: z.number().int().min(0).max(10000).optional(),
        confirmedSessionCount: z.number().int().min(0).max(100000).optional(),
        reviewTrayCount: z.number().int().min(0).max(100000).optional(),
      })
      .strict(),
  })
  .strict();

const FREE_TIER_REPORT_MODEL = 'gemini-4-hydrogen';

export function createReportsRouter(deps: {
  authStore: AuthStore;
  engineStore: EngineSQLStore;
}) {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role === 'client') {
        throw new HttpError(403, 'FORBIDDEN', 'Client portal users cannot view firm report settings.');
      }

      const tenantCfg = await deps.engineStore.getTenantConfig(authCtx.tenantId);
      const hasApiKey = Boolean(appConfig.geminiApiKey);
      return res.json({
        aiReportsEnabled: tenantCfg.aiReportsEnabled,
        aiProviderReady: appConfig.aiReportsGlobalAllow && hasApiKey,
        model: FREE_TIER_REPORT_MODEL,
        canToggle: authCtx.role === 'admin_it',
        aggregateOnly: true,
      });
    })
  );

  router.post(
    '/generate',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role === 'client') {
        throw new HttpError(403, 'FORBIDDEN', 'Client portal users cannot generate firm workforce reports.');
      }

      const tenantCfg = await deps.engineStore.getTenantConfig(authCtx.tenantId);
      if (!tenantCfg.aiReportsEnabled) {
        throw new HttpError(
          403,
          'AI_REPORTS_DISABLED',
          'AI Weekly Reports are disabled by default for this firm. An Admin/IT user may turn them on (aggregate numbers only).'
        );
      }

      const payload = AggregateReportRequestSchema.parse(req.body);

      if (!appConfig.aiReportsGlobalAllow || !appConfig.geminiApiKey) {
        return res.status(503).json({
          error:
            'AI narrative synthesis requires GEMINI_API_KEY in Settings > Secrets. Use deterministic local report generation in the meantime.',
          code: 'AI_PROVIDER_NOT_CONFIGURED',
          fallbackRecommended: true,
        });
      }

      const ai = new GoogleGenAI({
        apiKey: appConfig.geminiApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const toneDescriptions: Record<string, string> = {
        executive:
          'Write in a crisp, high-signal executive brief tone focusing on aggregate throughput, capacity utilization, and resource balance.',
        standup:
          'Write in an operations team lead tone focusing on aggregate task completion ratio, review queue sizing, and estimation accuracy.',
        client:
          'Write in a transparent firm delivery overview tone emphasizing aggregate billable ratio and milestone pacing.',
      };

      const { metrics, weekStartDate, weekEndDate, tone } = payload;

      const prompt = `Generate a Weekly Operations Brief for ${weekStartDate} to ${weekEndDate} strictly from these anonymized aggregate metrics (no client names, task titles, file paths, or application names are shared):
Tone Instruction: ${toneDescriptions[tone]}

Aggregate Quantitative Metrics:
- Total Logged Time: ${metrics.totalHours} hours (${metrics.totalMinutes} mins)
- Planned Capacity: ${metrics.plannedHours} hours
- Deep Work Share: ${metrics.deepWorkPercent}%
- Billable Share: ${metrics.billablePercent}%
- Tasks Completed: ${metrics.completedCount} of ${metrics.totalTasksCount}
- Active Reporting Staff: ${metrics.activeStaffCount ?? 'N/A'}
- Confirmed Attribution Sessions: ${metrics.confirmedSessionCount ?? 'N/A'}
- Pending Review Tray Count: ${metrics.reviewTrayCount ?? 'N/A'}

Produce structured operational guidance strictly referencing only the numbers provided above.`;

      try {
        const response = await ai.models.generateContent({
          model: FREE_TIER_REPORT_MODEL,
          contents: prompt,
          config: {
            systemInstruction:
              'You are an accounting practice operations analyst summarizing strictly anonymized numeric KPIs for OnTrack. Never invent client names, project names, or software names.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                executiveSummary: {
                  type: Type.STRING,
                  description:
                    'A 2-3 sentence quantitative summary highlighting aggregate hours, billable share, and completion rate.',
                },
                accomplishments: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    '3 concise bullet points summarizing numeric throughput and capacity metrics.',
                },
                blockersAndRisks: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    '2 to 3 numeric capacity, backlog, or variance risks derived strictly from the aggregate ratios.',
                },
                velocityInsights: {
                  type: Type.STRING,
                  description:
                    'Comparison of planned vs logged hours and deep-work share.',
                },
                nextWeekFocus: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    '3 recommended operational adjustments for the coming week.',
                },
              },
              required: [
                'executiveSummary',
                'accomplishments',
                'blockersAndRisks',
                'velocityInsights',
                'nextWeekFocus',
              ],
            },
          },
        });

        const rawText = response.text || '{}';
        const parsed = JSON.parse(rawText.trim());
        return res.json({ report: parsed, aggregateOnly: true, model: FREE_TIER_REPORT_MODEL });
      } catch (err: any) {
        const msg = String(err?.message || 'AI synthesis request failed');
        const status = Number(err?.status || err?.code) || 502;
        if (status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
          return res.status(429).json({
            error:
              'Free-tier Gemini rate limit reached. Try again shortly or use the deterministic local report.',
            code: 'AI_RATE_LIMITED',
            fallbackRecommended: true,
          });
        }
        if (status === 403 || status === 400 || msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED')) {
          return res.status(503).json({
            error:
              'Check your GEMINI_API_KEY in Settings > Secrets. Falling back to deterministic local report.',
            code: 'AI_KEY_INVALID',
            fallbackRecommended: true,
          });
        }
        return res.status(502).json({
          error: 'AI report generation temporarily unavailable. Falling back to deterministic local report.',
          code: 'AI_UPSTREAM_ERROR',
          fallbackRecommended: true,
        });
      }
    })
  );

  return router;
}
