"""Fixed limits and supported registrations for the first protocol version."""

EVENTS = (
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
    "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
    "SubagentStart", "SubagentStop", "Stop", "Interrupt",
)
MAX_PAYLOAD = 61440
MAX_FRAME = 384 * 1024
MAX_COUNTER = 2**53 - 1


def encode(message):
    import json
    return (json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
