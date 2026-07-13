"""Port of utils/activity.ts."""

from __future__ import annotations


def log_activity(
    db,
    *,
    org_id: str,
    action: str,
    entity_type: str,
    entity_id: str,
    user_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    row = {
        "org_id": org_id,
        "user_id": user_id,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
    }
    if metadata is not None:
        row["metadata"] = metadata
    db.insert("activity_log", row)
