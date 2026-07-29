#!/usr/bin/env bash
# Удаляет trailer Co-authored-by от агента IDE из всех коммитов текущей ветки.
# После прогона: git push --force-with-lease origin HEAD
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export FILTER_BRANCH_SQUELCH_WARNING=1

git filter-branch -f --msg-filter \
  'grep -v -E "^Co-authored-by: .+ <.+@cursor\.com>$"' \
  HEAD

branch="$(git rev-parse --abbrev-ref HEAD)"
if git show-ref --verify --quiet "refs/original/refs/heads/${branch}"; then
  git update-ref -d "refs/original/refs/heads/${branch}"
fi

echo
if git log --format='%B' | grep -qiE 'Co-authored-by: .+@cursor\.com|cursoragent@'; then
  echo "ВНИМАНИЕ: в сообщениях всё ещё есть co-author trailer агента"
  exit 1
fi

echo "OK: co-author trailers агента в сообщениях коммитов нет."
echo "Дальше: git push --force-with-lease origin HEAD"
