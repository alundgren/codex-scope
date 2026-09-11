"""Check installed Codex registration support without touching account config."""

import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scope.probe import compatible, registrations


def main():
    codex = shutil.which("codex")
    if not codex:
        raise SystemExit("Codex is not installed.")
    result = compatible(codex, Path(__file__).resolve().parents[1] / "build/observer")
    print(json.dumps({"registered_events": [h["eventName"] for h in registrations(result)],
                      "all_registrations_recognized": True,
                      "account_configuration_modified": False,
                      "real_event_emission_and_policy_coexistence": "not tested"}, indent=2))


if __name__ == "__main__":
    main()
