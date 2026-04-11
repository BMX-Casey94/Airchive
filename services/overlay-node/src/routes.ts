import type { Request, Response, Router } from "express";
import express from "express";

import type { AirchiveLookupService } from "./lookup-service.js";

export type ApiSuccess<T> = {
  success: true;
  data: T;
  pagination?: { limit: number; offset: number; total: number };
};

export type ApiFailure = {
  success: false;
  data: { message: string };
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

function ok<T>(
  data: T,
  pagination?: { limit: number; offset: number; total: number },
): ApiSuccess<T> {
  return pagination !== undefined
    ? { success: true, data, pagination }
    : { success: true, data };
}

function fail(message: string): ApiFailure {
  return { success: false, data: { message } };
}

function pathParam(req: Request, name: string): string {
  const v = req.params[name];
  if (Array.isArray(v)) {
    return v[0] ?? "";
  }
  return v ?? "";
}

function parseLimitOffset(req: Request, defLimit: number, max: number): {
  limit: number;
  offset: number;
} {
  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit =
    limitRaw === undefined
      ? defLimit
      : Math.min(max, Math.max(1, Number.parseInt(String(limitRaw), 10) || defLimit));
  const offset =
    offsetRaw === undefined
      ? 0
      : Math.max(0, Number.parseInt(String(offsetRaw), 10) || 0);
  return { limit, offset };
}

export function createRoutes(lookup: AirchiveLookupService): Router {
  const r = express.Router();

  r.get("/health", async (_req: Request, res: Response) => {
    try {
      await lookup.ping();
      const body: ApiEnvelope<{ status: string }> = ok({ status: "ok" });
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Health check failed";
      res.status(503).json(fail(msg));
    }
  });

  r.get("/lookup/icao/:icao", async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parseLimitOffset(req, 50, 500);
      const { rows, total } = await lookup.lookupByIcao(pathParam(req, "icao"), limit, offset);
      const body: ApiEnvelope<typeof rows> = ok(rows, { limit, offset, total });
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      res.status(400).json(fail(msg));
    }
  });

  r.get("/lookup/icao/:icao/latest", async (req: Request, res: Response) => {
    try {
      const countRaw = req.query.count;
      const count =
        countRaw === undefined
          ? 20
          : Math.min(200, Math.max(1, Number.parseInt(String(countRaw), 10) || 20));
      const rows = await lookup.getLatestRecords(pathParam(req, "icao"), count);
      const body: ApiEnvelope<typeof rows> = ok(rows);
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      res.status(400).json(fail(msg));
    }
  });

  r.get("/lookup/tx/:txid", async (req: Request, res: Response) => {
    try {
      const row = await lookup.lookupByTxId(pathParam(req, "txid"));
      if (row === null) {
        res.status(404).json(fail("Transaction not found"));
        return;
      }
      const body: ApiEnvelope<typeof row> = ok(row);
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      res.status(400).json(fail(msg));
    }
  });

  r.get("/lookup/time/:icao", async (req: Request, res: Response) => {
    try {
      const from = Number.parseInt(String(req.query.from ?? ""), 10);
      const to = Number.parseInt(String(req.query.to ?? ""), 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        res.status(400).json(fail("Query parameters from and to are required integers (Unix ms)"));
        return;
      }
      const rows = await lookup.lookupByTimeRange(pathParam(req, "icao"), from, to);
      const body: ApiEnvelope<typeof rows> = ok(rows);
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      res.status(400).json(fail(msg));
    }
  });

  r.get("/lookup/flight/:flightId", async (req: Request, res: Response) => {
    try {
      const rows = await lookup.lookupByFlightSession(pathParam(req, "flightId"));
      const body: ApiEnvelope<typeof rows> = ok(rows);
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      res.status(400).json(fail(msg));
    }
  });

  r.get("/sessions/:icao", async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parseLimitOffset(req, 50, 200);
      const { rows, total } = await lookup.getFlightSessions(pathParam(req, "icao"), limit, offset);
      const body: ApiEnvelope<typeof rows> = ok(rows, { limit, offset, total });
      res.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      res.status(400).json(fail(msg));
    }
  });

  return r;
}
