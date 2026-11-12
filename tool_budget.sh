#!/bin/bash
# tool_budget.sh — per-task tool-call budget for Claude Code.
#
# Every tool call Claude makes is a fresh API request that re-sends the whole
# conversation, so capping tool calls caps token spend. Wired as BOTH hooks in
# .claude/settings.json (same command; the event is detected from the JSON
# read on stdin):
#
#   PreToolUse        -> counts the call; denies it (exit 2) once the budget
#                        for this task is spent. The denial message is fed
#                        back to Claude so it wraps up in text.
#   UserPromptSubmit  -> resets the counter (one user message = one task) —
#                        but ONLY for a genuine user prompt. Automated
#                        re-invocations (background-task completions and
#                        injected reminders) also arrive through this event
#                        and must NOT reset, or every background completion
#                        would hand out a fresh budget mid-task.
#
# Escape hatch: when over budget, only PLAIN git progress commands pass —
# `git add|commit|push|status|diff|log` as the whole command, with no pipes,
# chains or substitution characters (`|;&`$`) anywhere in the input.
# Everything else stays denied, so file reads cannot be smuggled in as
# `git diff | grep` or `git grep`.
#
# Change the budget by editing this one number (or export TOOL_BUDGET=NN):
MAX_TOOL_CALLS="${TOOL_BUDGET:-15}"
# Warning starts when 25% of the budget is left: floor(0.75 * MAX).
# 15 -> 11, 8 -> 6, 4 -> 3. (TOOL_WARN_AT overrides the formula.)
WARN_AT="${TOOL_WARN_AT:-$((MAX_TOOL_CALLS * 3 / 4))}"
[ "$WARN_AT" -ge 1 ] || WARN_AT=1
[ "$WARN_AT" -le "$MAX_TOOL_CALLS" ] || WARN_AT=$MAX_TOOL_CALLS

INPUT=$(cat)

# session_id keys the counter file so parallel sessions don't share a budget.
SID=$(printf '%s' "$INPUT" \
      | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 \
      | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
[ -n "$SID" ] || SID="unknown"

COUNT_FILE="${TMPDIR:-/tmp}/claude_tool_budget_${SID}.count"

case "$INPUT" in
  *'"tool_name"'*)
    # ---- PreToolUse: enforce the budget ----
    N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
    case "$N" in ''|*[!0-9]*) N=0 ;; esac

    if [ "$N" -ge "$MAX_TOOL_CALLS" ]; then
      # Escape hatch: only PLAIN git progress commands pass over budget.
      # The command must start with a whitelisted git subcommand AND the
      # whole hook input must contain no pipe/chain/substitution character,
      # so file reads cannot be smuggled in as `git diff | grep`,
      # `git grep foo`, or `git status && cat src/...`.
      CMD=$(printf '%s' "$INPUT" \
            | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\).*/\1/p')
      if printf '%s' "$INPUT" | grep -qE '"tool_name"[[:space:]]*:[[:space:]]*"Bash"' \
         && printf '%s' "$CMD" | grep -qE '^git[[:space:]]+(add|commit|push|status|diff|log)([[:space:]]|$)' \
         && ! printf '%s' "$INPUT" | grep -qE '[|;&`$]'; then
        printf '{"systemMessage":"🔧 Tool budget exhausted — plain git allowed (%s/%s)"}\n' "$N" "$MAX_TOOL_CALLS"
        exit 0
      fi
      echo "Tool budget exhausted: ${MAX_TOOL_CALLS} tool calls per task. Further tool calls are denied — finish with a text-only summary (state what changed, what is uncommitted, what is left). Only one plain 'git add|commit|push|status|diff|log' command still passes (no pipes, chains or substitutions), to commit progress." >&2
      exit 2
    fi

    CALL=$((N + 1))
    echo "$CALL" > "$COUNT_FILE"

    # Live count for the user on every call; from WARN_AT on, also inject a
    # wrap-up warning into Claude's context.
    if [ "$CALL" -ge "$WARN_AT" ]; then
      printf '{"systemMessage":"🔧 Tool call %d/%d — ⚠️ budget warning: start wrapping up","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Tool budget: %d of %d tool calls used in this task (warning starts at call %d). Start wrapping up: batch remaining work into as few tool calls as possible and avoid exploratory calls. At %d further calls all tools are denied except a single plain git add/commit/push/status/diff/log (no pipes or chains)."}}\n' \
        "$CALL" "$MAX_TOOL_CALLS" "$CALL" "$MAX_TOOL_CALLS" "$WARN_AT" "$((MAX_TOOL_CALLS - CALL))"
    else
      printf '{"systemMessage":"🔧 Tool call %d/%d"}\n' "$CALL" "$MAX_TOOL_CALLS"
    fi
    exit 0
    ;;
  *)
    # ---- UserPromptSubmit: new task, reset the counter ----
    # Audit trail first: every submit we see, timestamped, so misfires of
    # this hook can be diagnosed after the fact.
    printf '%s\t%s\n' "$(date +%s)" "$INPUT" >> "${TMPDIR:-/tmp}/claude_tool_budget_${SID}.input.log"

    # Do NOT reset for automated re-invocations delivered as user-role turns:
    #   - notification turns carry BOTH the "[SYSTEM NOTIFICATION" banner and
    #     a "<task-notification>" tag (background/workflow completions);
    #   - an empty prompt means nothing was actually submitted.
    # Requiring BOTH markers keeps a user merely *quoting* one of them from
    # losing their reset.
    if { printf '%s' "$INPUT" | grep -q 'SYSTEM NOTIFICATION' \
         && printf '%s' "$INPUT" | grep -q 'task-notification'; } \
       || printf '%s' "$INPUT" | grep -qE '"prompt"[[:space:]]*:[[:space:]]*""'; then
      N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
      case "$N" in ''|*[!0-9]*) N=0 ;; esac
      printf '{"systemMessage":"🔧 Automated event — budget NOT reset (%s/%s used)"}\n' "$N" "$MAX_TOOL_CALLS"
      exit 0
    fi

    rm -f "$COUNT_FILE"
    printf '{"systemMessage":"🔧 New task — tool budget reset to 0/%s"}\n' "$MAX_TOOL_CALLS"
    exit 0
    ;;
esac