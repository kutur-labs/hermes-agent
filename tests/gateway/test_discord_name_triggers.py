"""Tests for plain-text Discord name triggers."""

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import PlatformConfig


def _ensure_discord_mock():
    if "discord" in sys.modules and hasattr(sys.modules["discord"], "__file__"):
        return

    discord_mod = MagicMock()
    discord_mod.Intents.default.return_value = MagicMock()
    discord_mod.DMChannel = type("DMChannel", (), {})
    discord_mod.Thread = type("Thread", (), {})
    discord_mod.ForumChannel = type("ForumChannel", (), {})
    discord_mod.Interaction = object
    discord_mod.app_commands = SimpleNamespace(
        describe=lambda **kwargs: (lambda fn: fn),
        choices=lambda **kwargs: (lambda fn: fn),
        Choice=lambda **kwargs: SimpleNamespace(**kwargs),
    )

    ext_mod = MagicMock()
    commands_mod = MagicMock()
    commands_mod.Bot = MagicMock
    ext_mod.commands = commands_mod

    sys.modules.setdefault("discord", discord_mod)
    sys.modules.setdefault("discord.ext", ext_mod)
    sys.modules.setdefault("discord.ext.commands", commands_mod)


_ensure_discord_mock()

import discord  # noqa: E402
from plugins.platforms.discord.adapter import (  # noqa: E402
    DiscordAdapter,
    _apply_yaml_config,
)


class FakeTree:
    def command(self, *, name, description):
        del name, description
        return lambda fn: fn


class FakeGuildChannel:
    def __init__(self, channel_id=123, name="general"):
        self.id = channel_id
        self.name = name
        self.parent_id = None
        self.guild = SimpleNamespace(id=456, name="Test Guild")
        self.topic = None
        self.send = AsyncMock()


@pytest.fixture
def adapter():
    config = PlatformConfig(enabled=True, token="***")
    config.extra["name_triggers"] = ["marcel"]
    adapter = DiscordAdapter(config)
    adapter._client = SimpleNamespace(
        tree=FakeTree(),
        get_channel=lambda _id: None,
        fetch_channel=AsyncMock(),
        user=SimpleNamespace(id=99999, name="HermesBot", bot=True),
    )
    adapter._text_batch_delay_seconds = 0
    adapter.handle_message = AsyncMock(return_value=True)
    return adapter


def _make_message(
    content,
    *,
    author=None,
    channel=None,
    mentions=None,
    message_id=1,
):
    channel = channel or FakeGuildChannel()
    author = author or SimpleNamespace(
        id=42,
        name="Jezza",
        display_name="Jezza",
        bot=False,
    )
    return SimpleNamespace(
        id=message_id,
        content=content,
        author=author,
        channel=channel,
        guild=channel.guild,
        mentions=list(mentions or []),
        type=discord.MessageType.default,
        message_snapshots=[],
        attachments=[],
        reference=None,
        created_at=datetime.now(timezone.utc),
    )


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("hey Marcel, can you help?", True),
        ("MARCEL please summarize this", True),
        ("what is Marcel's take?", True),
        ("marceline joined the channel", False),
        ("supermarcel is not a wake name", False),
        ("marcel_helper is not a wake name", False),
    ],
)
def test_name_trigger_matches_standalone_case_insensitively(
    adapter,
    content,
    expected,
):
    assert adapter._discord_content_has_name_trigger(content) is expected


def test_name_triggers_are_disabled_by_default(adapter):
    adapter.config.extra.pop("name_triggers")

    assert not adapter._message_invokes_self(_make_message("hey Marcel"))


@pytest.mark.asyncio
async def test_name_trigger_passes_mention_gate_without_changing_text(
    adapter,
    monkeypatch,
):
    monkeypatch.setenv("DISCORD_AUTO_THREAD", "false")
    monkeypatch.setenv("DISCORD_HISTORY_BACKFILL", "false")
    message = _make_message("hey Marcel, summarize this")

    assert await adapter._handle_message(message)
    event = adapter.handle_message.await_args.args[0]
    assert event.text == "hey Marcel, summarize this"


def test_name_trigger_allows_human_to_mention_another_bot(adapter, monkeypatch):
    monkeypatch.setattr(adapter, "_is_allowed_user", lambda *args, **kwargs: True)
    other_bot = SimpleNamespace(id=88888, bot=True)
    message = _make_message(
        "Marcel, compare your answer with this bot",
        mentions=[other_bot],
    )

    admitted, _ = adapter._discord_message_admission(message, claim=False)

    assert admitted


def test_other_bot_mention_without_name_trigger_is_rejected(adapter, monkeypatch):
    monkeypatch.setattr(adapter, "_is_allowed_user", lambda *args, **kwargs: True)
    other_bot = SimpleNamespace(id=88888, bot=True)
    message = _make_message("can this bot help?", mentions=[other_bot])

    admitted, _ = adapter._discord_message_admission(message, claim=False)

    assert not admitted


def test_unauthorized_name_trigger_is_rejected(adapter, monkeypatch):
    monkeypatch.setattr(adapter, "_is_allowed_user", lambda *args, **kwargs: False)

    admitted, _ = adapter._discord_message_admission(
        _make_message("Marcel, do something"),
        claim=False,
    )

    assert not admitted


@pytest.mark.asyncio
async def test_ignored_channel_still_rejects_name_trigger(adapter, monkeypatch):
    monkeypatch.setenv("DISCORD_IGNORED_CHANNELS", "123")
    message = _make_message("Marcel, do something")

    assert not await adapter._handle_message(message)
    adapter.handle_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_bot_author_cannot_use_plain_name_trigger(adapter, monkeypatch):
    monkeypatch.setenv("DISCORD_AUTO_THREAD", "false")
    bot_author = SimpleNamespace(
        id=88888,
        name="OtherBot",
        display_name="OtherBot",
        bot=True,
    )
    message = _make_message("Marcel, do something", author=bot_author)

    assert not await adapter._handle_message(message)
    adapter.handle_message.assert_not_awaited()


def test_yaml_name_triggers_bridge_to_runtime_config(monkeypatch):
    monkeypatch.delenv("DISCORD_NAME_TRIGGERS", raising=False)

    _apply_yaml_config({}, {"name_triggers": ["marcel", "mars"]})

    assert os.environ["DISCORD_NAME_TRIGGERS"] == "marcel,mars"


@pytest.mark.asyncio
async def test_recovered_messages_use_same_name_trigger_gate(adapter, monkeypatch):
    monkeypatch.setattr(
        adapter,
        "_discord_message_admission",
        MagicMock(return_value=(True, False)),
    )
    adapter._handle_message = AsyncMock(return_value=True)

    assert await adapter._dispatch_recovered_message(
        _make_message("Marcel, recover this", message_id=10)
    )
    adapter._handle_message.assert_awaited_once()

    adapter._handle_message.reset_mock()
    assert not await adapter._dispatch_recovered_message(
        _make_message("Marceline posted this", message_id=11)
    )
    adapter._handle_message.assert_not_awaited()
