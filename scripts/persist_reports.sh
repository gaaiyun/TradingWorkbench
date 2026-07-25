#!/usr/bin/env bash
# 把本次运行产物（public/data + public/reports）安全地提交回 main。
# 不依赖 git 合并：产物先挪走，工作区重置到远端最新，再显式叠加回来——
# 报告路径唯一直接覆盖；history.json 用 update_history 幂等融合；latest.json 取本次。
# 用法: bash scripts/persist_reports.sh "<commit message>"
set -euo pipefail

MSG="${1:-chore(data): 更新分析报告 [skip ci]}"
TMP="$(mktemp -d)"

cp -r public/data "$TMP/data"
[ -d public/reports ] && cp -r public/reports "$TMP/reports" || true

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3; do
  git fetch origin main
  git checkout -B main origin/main

  [ -d "$TMP/reports" ] && { mkdir -p public/reports; cp -rf "$TMP/reports/." public/reports/; }
  cp -f "$TMP/data/latest.json" public/data/latest.json
  # 远端最新 history + 本次 entry 幂等融合（同交易日同标的组合覆盖）
  python - <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, "scripts")
from run_daily import update_history
payload = json.loads(Path("public/data/latest.json").read_text(encoding="utf-8"))
if payload.get("results"):
    update_history(Path("public/data"), payload)
PY
  # 审计索引必须和刚融合的 history 及版本化报告同一提交发布。
  node scripts/report-audit.mjs

  git add public/data public/reports
  if git diff --cached --quiet; then
    echo "[persist] no changes"
    exit 0
  fi
  git commit -m "$MSG"
  if git push origin main; then
    echo "[persist] pushed (attempt $attempt)"
    exit 0
  fi
  echo "[persist] push raced, retrying ($attempt)"
  git reset --soft origin/main
done

echo "[persist] FAILED after 3 attempts" >&2
exit 1
