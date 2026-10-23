import type { Request, Response } from 'express';
import { getHealthReport } from '../services/health.service.js';

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const report = await getHealthReport();
  res.status(report.status === 'ok' ? 200 : 503).json(report);
}
