DELETE FROM market_bars
WHERE timeframe = '5m'
  AND source = 'yahoo'
  AND (symbol LIKE '%.SS' OR symbol LIKE '%.SZ')
  AND (
    (
      strftime('%H:%M', datetime(ts, '+8 hours')) > '11:30'
      AND strftime('%H:%M', datetime(ts, '+8 hours')) < '13:00'
    )
    OR (
      strftime('%H:%M', datetime(ts, '+8 hours')) IN ('11:30', '15:00')
      AND CAST(volume AS REAL) = 0
      AND CAST(open AS REAL) = CAST(high AS REAL)
      AND CAST(open AS REAL) = CAST(low AS REAL)
      AND CAST(open AS REAL) = CAST(close AS REAL)
    )
  );
