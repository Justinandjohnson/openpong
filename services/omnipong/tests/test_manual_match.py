"""Tests for POST /tools/matches (manual match capture).

Each test runs against a throwaway SQLite file (``OMNIPONG_DB``) with a seeded
owner row, so the service never touches the real corpus. The endpoint is
idempotent per (date, opponent_name, score_summary, source): a repeated POST
returns the existing row with ``created: false``.
"""
import atexit
import os
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

# Point the service at a temp DB *before* importing it: the engine is created at
# import time from OMNIPONG_DB.
_DB_DIR = tempfile.mkdtemp(prefix="omnipong-manual-match-")
os.environ["OMNIPONG_DB"] = os.path.join(_DB_DIR, "test.db")
atexit.register(shutil.rmtree, _DB_DIR, True)

from sqlalchemy import text  # noqa: E402

import backend.main as main  # noqa: E402

OWNER = "Test Owner"
client = TestClient(main.app)


@pytest.fixture(autouse=True)
def clean_matches_and_seed_owner():
    session = main.SessionLocal()
    try:
        session.execute(text("DELETE FROM matches"))
        session.execute(text("DELETE FROM users"))
        session.execute(
            text("INSERT INTO users (id, name, current_rating) VALUES (1, :name, 1500)"),
            {"name": OWNER},
        )
        session.commit()
    finally:
        session.close()
    yield


def matches():
    response = client.get("/matches")
    assert response.status_code == 200
    return response.json()


def payload(**overrides):
    body = {
        "date": "2026-11-16",
        "opponent_name": "Opponent One",
        "opponent_rating": 1425,
        "result": "Win",
        "score_summary": "3-1",
        "set_scores": [11, 9, 9, 11, 11, 7, 11, 8],
    }
    body.update(overrides)
    return body


def test_insert_returns_created_match_and_get_matches_reflects_it():
    response = client.post("/tools/matches", json=payload())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "success"
    assert body["created"] is True
    assert isinstance(body["match_id"], int)

    rows = matches()
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == body["match_id"]
    assert row["opponent_name"] == "Opponent One"
    assert row["opponent_rating"] == 1425
    assert row["result"] == "Win"
    assert row["score_summary"] == "3-1"
    # Owner-first games are serialized to the string form existing readers parse.
    assert row["set_scores"] == "11-9, 9-11, 11-7, 11-8"
    assert row["source"] == "arcade"

    session = main.SessionLocal()
    try:
        record = session.execute(
            text("SELECT winner_name, loser_name FROM matches WHERE id = :id"),
            {"id": body["match_id"]},
        ).fetchone()
    finally:
        session.close()
    assert record.winner_name == OWNER
    assert record.loser_name == "Opponent One"


def test_same_result_twice_is_idempotent():
    first = client.post("/tools/matches", json=payload())
    second = client.post("/tools/matches", json=payload())
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert second.json()["match_id"] == first.json()["match_id"]
    assert len(matches()) == 1

    # A genuinely different result (different score) is a new row, not a duplicate.
    other = client.post("/tools/matches", json=payload(score_summary="3-0", set_scores=None))
    assert other.json()["created"] is True
    assert other.json()["match_id"] != first.json()["match_id"]
    assert len(matches()) == 2


def test_loss_names_the_opponent_as_winner_and_accepts_string_sets():
    response = client.post(
        "/tools/matches",
        json=payload(
            result="Loss",
            score_summary="1-3",
            set_scores="9-11, 11-8, 8-11, 6-11",
            source="manual",
        ),
    )
    assert response.status_code == 200, response.text
    match_id = response.json()["match_id"]

    session = main.SessionLocal()
    try:
        record = session.execute(
            text(
                "SELECT winner_name, loser_name, set_scores, source FROM matches WHERE id = :id"
            ),
            {"id": match_id},
        ).fetchone()
    finally:
        session.close()
    assert record.winner_name == "Opponent One"
    assert record.loser_name == OWNER
    assert record.set_scores == "9-11, 11-8, 8-11, 6-11"
    assert record.source == "manual"


@pytest.mark.parametrize(
    "overrides",
    [
        {"date": "not-a-date"},
        {"opponent_name": "   "},
        {"set_scores": [11, 9, 7]},
        {"opponent_rating": 99999},
    ],
)
def test_validation_errors_are_4xx_never_500(overrides):
    response = client.post("/tools/matches", json=payload(**overrides))
    assert response.status_code in (400, 422), response.text
    assert response.status_code != 500