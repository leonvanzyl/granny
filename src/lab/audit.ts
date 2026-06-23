// ============================================================================
// lab/audit.ts — MULTI-SEED headless world audit (pure; no scene, no mode).
//
// WHY THIS EXISTS: the Debug Lab normally inspects the world at ONE seed (1234).
// But builder variation AND item placement are seeded, so a defect can hide on
// the spot-checked seed and only surface on another. analyzeWorld() answers "is
// THIS world healthy?"; auditSeeds() answers the question that actually matters:
// "is the level healthy ACROSS seeds?" — in a single call.
//
// It rebuilds the whole world per seed HEADLESSLY (throwaway THREE.Group as the
// scene, a no-op rig that satisfies rig.addFixture), runs analyzeWorld, and rolls
// the per-seed summaries up into a pass/fail aggregate that names exactly which
// checks broke and on which seeds.
//
// EXPECTED-OK CARVE-OUT: roomsUnreachable === 1 is NOT a failure — that one
// room is the puzzle-locked cellar (its door is locked as-built, so flood-fill
// from spawn legitimately can't reach it). Only roomsUnreachable > 1 is flagged.
//
// Pure + dependency-light: imports only buildWorld, PhysicsWorld, analyzeWorld,
// and THREE. The shell wires window.LAB.audit = auditSeeds; this is NOT a mode.
// NOTE: buildWorld may console.warn about skipped furniture — that is expected.
// ============================================================================
import * as THREE from 'three';
import { buildWorld } from '../world';
import { PhysicsWorld } from '../physics';
import { analyzeWorld } from './diagnostics';
import type { WorldDiagnostics } from './diagnostics';

/** Default seed set — modest (6) because every seed rebuilds the whole world. */
export const DEFAULT_AUDIT_SEEDS = [1234, 1, 2, 7, 42, 99];

type Summary = WorldDiagnostics['summary'];

/** One failing check on one seed: the summary key plus its nonzero count. */
export interface AuditFail {
  check: string;   // summary key, e.g. "doorsMisaligned"
  count: number;   // the offending nonzero count
}

/** Full result for a single seed. */
export interface SeedAudit {
  seed: number;
  summary: Summary;
  fails: AuditFail[];   // empty => this seed PASSED
  passed: boolean;
}

/** Rolled-up verdict across all audited seeds. */
export interface AuditAggregate {
  anySeedFailed: boolean;
  /** check name -> seeds on which it failed (only checks that ever failed). */
  checksEverFailed: Record<string, number[]>;
  /** seed with the most failing checks (null if every seed passed). */
  worstSeed: number | null;
}

export interface AuditResult {
  seeds: number[];
  perSeed: SeedAudit[];
  aggregate: AuditAggregate;
}

// ---------------------------------------------------------------------------
// Which summary counts mean "broken". Each entry maps a summary key to a
// predicate over its value: most checks fail when the count is > 0, but
// roomsUnreachable tolerates exactly 1 (the locked cellar) and only fails > 1.
// ---------------------------------------------------------------------------
const CHECKS: Array<{ key: keyof Summary; fail: (n: number) => boolean }> = [
  { key: 'doorsMisaligned',      fail: (n) => n > 0 },
  { key: 'anchorsBad',           fail: (n) => n > 0 },
  // exactly 1 unreachable room is the puzzle-locked cellar — expected/ok.
  { key: 'roomsUnreachable',     fail: (n) => n > 1 },
  { key: 'blockingHits',         fail: (n) => n > 0 },
  { key: 'placementFloating',    fail: (n) => n > 0 },
  { key: 'placementOutOfRoom',   fail: (n) => n > 0 },
  { key: 'placementOverlaps',    fail: (n) => n > 0 },
];

/** Headless rig: buildWorld only calls rig.addFixture; return a throwaway. */
function noopRig() {
  return { addFixture: () => ({}) };
}

/** Build one world headlessly and collect its failing checks. */
function auditOne(seed: number): SeedAudit {
  const physics = new PhysicsWorld();
  // headless: throwaway scene group (buildWorld adds meshes to it) + no-op rig.
  const world = buildWorld(physics, new THREE.Group() as any, noopRig() as any, seed);
  const diag = analyzeWorld(world, physics);
  const summary = diag.summary;

  const fails: AuditFail[] = [];
  for (const { key, fail } of CHECKS) {
    const count = summary[key];
    if (fail(count)) fails.push({ check: key, count });
  }

  return { seed, summary, fails, passed: fails.length === 0 };
}

/**
 * Run the world audit across several seeds and aggregate the result.
 * @param seeds  seeds to audit (defaults to DEFAULT_AUDIT_SEEDS — ~6 seeds).
 */
export function auditSeeds(seeds: number[] = DEFAULT_AUDIT_SEEDS): AuditResult {
  const perSeed = seeds.map(auditOne);

  // aggregate: which checks ever failed, on which seeds; and the worst seed.
  const checksEverFailed: Record<string, number[]> = {};
  for (const s of perSeed) {
    for (const f of s.fails) {
      (checksEverFailed[f.check] ||= []).push(s.seed);
    }
  }

  let worstSeed: number | null = null;
  let worstCount = 0;
  for (const s of perSeed) {
    if (s.fails.length > worstCount) {
      worstCount = s.fails.length;
      worstSeed = s.seed;
    }
  }

  return {
    seeds,
    perSeed,
    aggregate: {
      anySeedFailed: perSeed.some((s) => !s.passed),
      checksEverFailed,
      worstSeed,
    },
  };
}

// ---------------------------------------------------------------------------
// Human-readable rollup — one line per seed plus a final aggregate verdict.
// Suitable for readout.set(...) or console.log(...).
// ---------------------------------------------------------------------------
export function summarizeAudit(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`AUDIT — ${result.perSeed.length} seed(s)`);

  for (const s of result.perSeed) {
    if (s.passed) {
      lines.push(`  seed ${s.seed}: PASS`);
    } else {
      const detail = s.fails.map((f) => `${f.check}=${f.count}`).join(', ');
      lines.push(`  seed ${s.seed}: FAIL  ${detail}`);
    }
  }

  const ag = result.aggregate;
  if (!ag.anySeedFailed) {
    lines.push(`AGGREGATE: PASS — all seeds healthy`);
  } else {
    const checks = Object.keys(ag.checksEverFailed)
      .map((k) => `${k} [${ag.checksEverFailed[k].join(',')}]`)
      .join('; ');
    lines.push(`AGGREGATE: FAIL — worstSeed=${ag.worstSeed}; checks: ${checks}`);
  }

  return lines.join('\n');
}
