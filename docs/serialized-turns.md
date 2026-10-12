# Serialized turns and interrupted capture

A logical turn begins when a prompt is admitted. Its starting workspace capture
is ready before the request reaches the engine. The root and its tracked
delegated sessions must settle before another prompt can start a new turn.

Stopping pauses that logical turn. A continuation or correction uses the same
original baseline. The trace preserves every submitted message and tool result;
it does not rewrite or delete the first prompt. Only natural completion advances
the baseline. Failed or unverifiable cancellation must keep admission closed.

## Capture records

The existing message and tool records, upload schemas, privacy rules, archive
layout and engine turn counts remain compatible. Additive metadata describes the
logical replay unit:

- `collector.replay_group`: `schema: 1`, `group_id`, `phase`,
  `prompt_count`, `message_ids`, `baseline_at`, and, when available,
  `baseline_snapshot: {segment, sequence}`.
- Phases: `start`, `paused`, `resumed`, `completed`, `incomplete`.
- `turn.diff` and `turn.completed` carry `replay_group_id` while grouped.

The original manifest and group identity are saved atomically in private local
capture state. Restart restores that baseline only for the same project and
account. A missing or corrupt required baseline prevents continuation; the
collector must not silently replace it with the current files.

A consumer that builds independent replay tasks must use this grouping and the
original baseline. Existing backend displays may still count individual engine
messages until they consume the new metadata.

## Boundaries

This coordinates tracked engine sessions through this app's admission surface.
It cannot freeze writes from unrelated editors, another app process, or detached
background services. It does not make a filesystem snapshot atomic, expand file
capture limits, collect credentials, or guarantee that every external dependency
is reproducible.

## Validation

The PR evidence records public boundary/journey results separately from unit
checks, including any missing infrastructure. Focused collector checks cover
Stop/resume, app restart, refused replacement snapshots, worker acknowledgements,
and the existing upload/spool/recovery paths.
