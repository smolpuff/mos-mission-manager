from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .models import AccountSnapshot, Mission, WalletSummary


class ProviderError(RuntimeError):
    pass


class AccountProvider:
    def fetch_snapshot(self) -> AccountSnapshot:
        raise NotImplementedError


@dataclass
class MockProvider(AccountProvider):
    now: datetime

    def fetch_snapshot(self) -> AccountSnapshot:
        return AccountSnapshot(
            missions=[
                Mission(
                    id="m1",
                    name="Win 3 races",
                    progress=3,
                    goal=3,
                    reward_value=120,
                    cooldown_ends_at=None,
                    claimable=True,
                ),
                Mission(
                    id="m2",
                    name="Collect 500 sparks",
                    progress=460,
                    goal=500,
                    reward_value=200,
                    cooldown_ends_at=None,
                    claimable=False,
                ),
                Mission(
                    id="m3",
                    name="Daily boost run",
                    progress=0,
                    goal=1,
                    reward_value=90,
                    cooldown_ends_at=self.now + timedelta(minutes=42),
                    claimable=False,
                ),
            ],
            wallet=WalletSummary(balance=1480, pending_rewards=120),
        )


class PbpMcpProvider(AccountProvider):
    def fetch_snapshot(self) -> AccountSnapshot:
        raise ProviderError(
            "PbpMcpProvider is not implemented yet. Use '--provider mock' for now."
        )


def get_provider(name: str, now: datetime) -> AccountProvider:
    if name == "mock":
        return MockProvider(now=now)
    if name == "pbp-mcp":
        return PbpMcpProvider()
    raise ProviderError(f"Unknown provider: {name}")
