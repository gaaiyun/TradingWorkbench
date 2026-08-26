/**
 * Date-rot detector: shifts the process clock forward before the test suite runs.
 *
 * Several APIs here (market freshness, report lag, monitor slots) recompute
 * status against the wall clock at read time. A test that hardcodes fixture
 * dates but does NOT pin the clock therefore passes on the day it is written
 * and starts failing days later — on a schedule, silently, in CI.
 *
 * That has now bitten three times:
 *   - test_fund_flow_api.mjs   (hardcoded trade_date -> report_lag)
 *   - test_dynamic_api.mjs     (intraday staleness)
 *   - test_dynamic_api.mjs     ("provider fallbacks overlap": broke the
 *                               every-30-minutes pages-snapshot schedule in
 *                               two repos and mailed a failure per run)
 *
 * Preload this with `node --require` and TEST_CLOCK_SHIFT_DAYS set to run the
 * whole suite "in the future". Tests that legitimately pin their own clock
 * (t.mock.method(Date, "now", ...)) override the shift and stay deterministic,
 * so only genuine wall-clock dependencies fail.
 *
 * Usage: TEST_CLOCK_SHIFT_DAYS=90 node --require ./tests/helpers/clock-shift.cjs --test ...
 */
const shiftDays = Number(process.env.TEST_CLOCK_SHIFT_DAYS || 0);

if (Number.isFinite(shiftDays) && shiftDays !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const offsetMs = shiftDays * 24 * 60 * 60 * 1000;

  class ShiftedDate extends RealDate {
    constructor(...args) {
      // Only a bare `new Date()` means "now" — every explicit form must keep
      // its exact argument, or fixture timestamps would drift too.
      if (args.length === 0) {
        super(realNow() + offsetMs);
      } else {
        super(...args);
      }
    }

    static now() {
      return realNow() + offsetMs;
    }
  }

  globalThis.Date = ShiftedDate;
}
