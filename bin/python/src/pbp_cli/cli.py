from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from .models import AccountSnapshot, Mission
from .providers import ProviderError, get_provider


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="pbp", description="PbP helper CLI")
    parser.add_argument("--provider", default="mock", choices=["mock", "pbp-mcp"])
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("status", help="Show missions, cooldowns, wallet, and claimables")
    subparsers.add_parser("suggest", help="Rank next actions by value/time")

    return parser.parse_args()


def _mission_eta_minutes(mission: Mission, now: datetime) -> int | None:
    if mission.cooldown_ends_at is None:
        return None
    delta = mission.cooldown_ends_at - now
    return max(0, int(delta.total_seconds() // 60))


def _to_status_payload(snapshot: AccountSnapshot, now: datetime) -> dict:
    claimables = [m for m in snapshot.missions if m.claimable]
    missions = []
    for m in snapshot.missions:
        missions.append(
            {
                "id": m.id,
                "name": m.name,
                "progress": f"{m.progress}/{m.goal}",
                "claimable": m.claimable,
                "cooldown_minutes": _mission_eta_minutes(m, now),
                "reward_value": m.reward_value,
            }
        )

    return {
        "wallet": {
            "balance": snapshot.wallet.balance,
            "pending_rewards": snapshot.wallet.pending_rewards,
        },
        "claimable_count": len(claimables),
        "missions": missions,
    }


def _progress_ratio(mission: Mission) -> float:
    if mission.goal <= 0:
        return 0.0
    return min(1.0, mission.progress / mission.goal)


def _to_suggestions(snapshot: AccountSnapshot, now: datetime) -> list[dict]:
    suggestions: list[dict] = []

    for m in snapshot.missions:
        if m.claimable:
            suggestions.append(
                {
                    "action": f"Claim reward: {m.name}",
                    "value": m.reward_value,
                    "time_minutes": 1,
                    "reason": "Already complete; instant payout",
                }
            )
            continue

        eta = _mission_eta_minutes(m, now)
        if eta is not None:
            suggestions.append(
                {
                    "action": f"Queue after cooldown: {m.name}",
                    "value": m.reward_value,
                    "time_minutes": eta,
                    "reason": f"Cooldown ends in {eta}m",
                }
            )
            continue

        ratio = _progress_ratio(m)
        eta_guess = max(5, int((1.0 - ratio) * 60))
        suggestions.append(
            {
                "action": f"Finish mission: {m.name}",
                "value": m.reward_value,
                "time_minutes": eta_guess,
                "reason": f"{int(ratio * 100)}% complete",
            }
        )

    suggestions.sort(
        key=lambda s: (-(s["value"] / max(1, s["time_minutes"])), -s["value"], s["time_minutes"])
    )
    return suggestions


def _print_status_text(payload: dict) -> None:
    wallet = payload["wallet"]
    print("Wallet")
    print(f"- Balance: {wallet['balance']}")
    print(f"- Pending Rewards: {wallet['pending_rewards']}")
    print(f"- Claimable Missions: {payload['claimable_count']}")

    print("\nMissions")
    for m in payload["missions"]:
        cooldown = "-" if m["cooldown_minutes"] is None else f"{m['cooldown_minutes']}m"
        print(
            f"- {m['name']}: {m['progress']} | claimable={m['claimable']} | cooldown={cooldown} | reward={m['reward_value']}"
        )


def _print_suggest_text(suggestions: list[dict]) -> None:
    for i, s in enumerate(suggestions, start=1):
        print(
            f"{i}. {s['action']} | value={s['value']} | est_time={s['time_minutes']}m | {s['reason']}"
        )


def main() -> int:
    args = _parse_args()
    now = datetime.now(timezone.utc)

    try:
        provider = get_provider(args.provider, now)
        snapshot = provider.fetch_snapshot()
    except ProviderError as exc:
        print(f"error: {exc}")
        return 2

    if args.command == "status":
        payload = _to_status_payload(snapshot, now)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            _print_status_text(payload)
        return 0

    if args.command == "suggest":
        suggestions = _to_suggestions(snapshot, now)
        if args.json:
            print(json.dumps({"suggestions": suggestions}, indent=2))
        else:
            _print_suggest_text(suggestions)
        return 0

    print(f"error: unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
