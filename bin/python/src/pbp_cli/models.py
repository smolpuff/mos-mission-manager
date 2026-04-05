from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Mission:
    id: str
    name: str
    progress: int
    goal: int
    reward_value: int
    cooldown_ends_at: datetime | None
    claimable: bool


@dataclass(frozen=True)
class WalletSummary:
    balance: int
    pending_rewards: int


@dataclass(frozen=True)
class AccountSnapshot:
    missions: list[Mission]
    wallet: WalletSummary
