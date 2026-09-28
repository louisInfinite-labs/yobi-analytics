import json

import pytest

from tracking.creator_avatar_sync import AvatarSyncChange, AvatarSyncPlan, apply_avatar_update_plan, compute_avatar_update_plan
from tracking.creator_master import Creator, CreatorMasterError, load_creators


def _creator(**overrides) -> Creator:
    fields = {
        "creator_id": "test_creator",
        "display_name": "Test Creator",
        "organization": "vspo",
        "youtube_channel_id": "UC_TEST",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["NO"],
        "channel_type": "member",
        "lifecycle_stage": "active",
    }
    fields.update(overrides)
    return Creator(**fields)


# --- compute_avatar_update_plan (pure) --------------------------------------


def test_plan_identifies_a_new_avatar_as_a_change():
    creator = _creator(avatar_url=None)

    plan = compute_avatar_update_plan([creator], {"UC_TEST": "https://example.com/new.jpg"})

    assert plan.has_changes
    assert plan.changes == [
        AvatarSyncChange(creator_id="test_creator", old_avatar_url=None, new_avatar_url="https://example.com/new.jpg")
    ]
    assert plan.unchanged_creator_ids == []


def test_plan_only_includes_creators_whose_avatar_actually_changed():
    unchanged_creator = _creator(creator_id="unchanged", youtube_channel_id="UC_A", avatar_url="https://example.com/same.jpg")
    changed_creator = _creator(creator_id="changed", youtube_channel_id="UC_B", avatar_url="https://example.com/old.jpg")

    plan = compute_avatar_update_plan(
        [unchanged_creator, changed_creator],
        {"UC_A": "https://example.com/same.jpg", "UC_B": "https://example.com/new.jpg"},
    )

    assert [change.creator_id for change in plan.changes] == ["changed"]
    assert "unchanged" in plan.unchanged_creator_ids


def test_unchanged_avatar_produces_no_change_entry():
    """A fetched avatar identical to what's already stored is not a 'change' --
    applying this plan must not write anything for this creator."""
    creator = _creator(avatar_url="https://example.com/same.jpg")

    plan = compute_avatar_update_plan([creator], {"UC_TEST": "https://example.com/same.jpg"})

    assert plan.changes == []
    assert plan.unchanged_creator_ids == ["test_creator"]


def test_existing_avatar_preserved_when_refresh_finds_nothing():
    """A creator whose channel produced no fresh avatar (missing from the
    fetch result entirely) keeps their existing non-null avatarUrl."""
    creator = _creator(avatar_url="https://example.com/existing.jpg")

    plan = compute_avatar_update_plan([creator], {})  # nothing fetched for UC_TEST

    assert plan.changes == []
    assert plan.unchanged_creator_ids == ["test_creator"]


def test_null_avatar_remains_null_when_no_thumbnail_found():
    creator = _creator(avatar_url=None)

    plan = compute_avatar_update_plan([creator], {}, {"UC_TEST": "No usable thumbnail"})

    assert plan.changes == []
    assert plan.unchanged_creator_ids == ["test_creator"]
    assert plan.skip_reasons == {"test_creator": "No usable thumbnail"}


def test_refresh_failure_never_replaces_a_valid_avatar_with_null():
    """A creator with a valid existing avatarUrl whose refresh failed keeps
    the valid value -- the plan must never turn it into a None/removal."""
    creator = _creator(avatar_url="https://example.com/still-valid.jpg")

    plan = compute_avatar_update_plan([creator], {}, {"UC_TEST": "YouTube API error: boom"})

    assert plan.changes == []
    assert creator.avatar_url == "https://example.com/still-valid.jpg"  # never mutated
    assert plan.skip_reasons == {"test_creator": "YouTube API error: boom"}


# --- apply_avatar_update_plan (disk I/O) ------------------------------------


def _write_fixture(tmp_path, records):
    path = tmp_path / "creators.json"
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _base_record(**overrides):
    record = {
        "creatorId": "test_creator",
        "displayName": "Test Creator",
        "organization": "vspo",
        "youtubeChannelId": "UC_TEST",
        "active": True,
        "branch": "vspo_jp",
        "groupKey": ["NO"],
        "channelType": "member",
        "lifecycleStage": "active",
        "themeColor": "#AABBCC",
    }
    record.update(overrides)
    return record


def test_apply_writes_only_avatar_url_in_a_temporary_fixture(tmp_path):
    path = _write_fixture(tmp_path, [_base_record()])
    plan = AvatarSyncPlan(changes=[AvatarSyncChange("test_creator", None, "https://example.com/new.jpg")])

    updated = apply_avatar_update_plan(plan, path)

    assert updated == 1
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written[0]["avatarUrl"] == "https://example.com/new.jpg"


def test_apply_preserves_every_unrelated_field(tmp_path):
    original = _base_record(themeColor="#123456", groupKey=["1期生", "ゲーマーズ"], discoveryEnabled=False)
    path = _write_fixture(tmp_path, [original])
    plan = AvatarSyncPlan(changes=[AvatarSyncChange("test_creator", None, "https://example.com/new.jpg")])

    apply_avatar_update_plan(plan, path)

    written = json.loads(path.read_text(encoding="utf-8"))[0]
    for key, value in original.items():
        assert written[key] == value


def test_apply_does_not_touch_a_second_unrelated_creator(tmp_path):
    other = _base_record(creatorId="other_creator", youtubeChannelId="UC_OTHER", avatarUrl="https://example.com/other.jpg")
    target = _base_record()
    path = _write_fixture(tmp_path, [other, target])
    plan = AvatarSyncPlan(changes=[AvatarSyncChange("test_creator", None, "https://example.com/new.jpg")])

    apply_avatar_update_plan(plan, path)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written[0]["avatarUrl"] == "https://example.com/other.jpg"  # untouched
    assert written[1]["avatarUrl"] == "https://example.com/new.jpg"


def test_apply_preserves_creator_order(tmp_path):
    records = [_base_record(creatorId=f"creator_{i}", youtubeChannelId=f"UC_{i}") for i in range(5)]
    path = _write_fixture(tmp_path, records)
    plan = AvatarSyncPlan(changes=[AvatarSyncChange("creator_3", None, "https://example.com/new.jpg")])

    apply_avatar_update_plan(plan, path)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert [record["creatorId"] for record in written] == [f"creator_{i}" for i in range(5)]


def test_apply_is_a_no_op_when_plan_has_no_changes(tmp_path):
    """An all-unchanged plan must not write to disk at all -- no file churn."""
    path = _write_fixture(tmp_path, [_base_record()])
    original_bytes = path.read_bytes()
    original_mtime = path.stat().st_mtime_ns
    plan = AvatarSyncPlan(changes=[], unchanged_creator_ids=["test_creator"])

    updated = apply_avatar_update_plan(plan, path)

    assert updated == 0
    assert path.read_bytes() == original_bytes
    assert path.stat().st_mtime_ns == original_mtime


def test_apply_raises_when_a_planned_creator_no_longer_exists_in_the_file(tmp_path):
    path = _write_fixture(tmp_path, [_base_record(creatorId="someone_else", youtubeChannelId="UC_OTHER")])
    plan = AvatarSyncPlan(changes=[AvatarSyncChange("test_creator", None, "https://example.com/new.jpg")])

    with pytest.raises(CreatorMasterError):
        apply_avatar_update_plan(plan, path)


def test_dry_run_never_touches_the_source_file(tmp_path):
    """Computing a plan (the dry-run path) is pure -- it takes no path at all,
    so the fixture file on disk cannot be modified by it."""
    path = _write_fixture(tmp_path, [_base_record()])
    original_bytes = path.read_bytes()
    creators = load_creators(path)

    compute_avatar_update_plan(creators, {"UC_TEST": "https://example.com/new.jpg"})

    assert path.read_bytes() == original_bytes


def test_apply_never_writes_to_any_path_other_than_the_one_given(tmp_path, monkeypatch):
    """Confirms apply_avatar_update_plan only ever writes the exact `path` it
    was given -- never a second, hardcoded location such as the frontend's
    generated Creator Registry artifact."""
    path = _write_fixture(tmp_path, [_base_record()])
    plan = AvatarSyncPlan(changes=[AvatarSyncChange("test_creator", None, "https://example.com/new.jpg")])

    written_paths = []
    import tracking.creator_avatar_sync as module

    real_write = module.write_json_list

    def _recording_write(write_path, data, **kwargs):
        written_paths.append(write_path)
        return real_write(write_path, data, **kwargs)

    monkeypatch.setattr(module, "write_json_list", _recording_write)

    apply_avatar_update_plan(plan, path)

    assert written_paths == [path]
    assert not any("generated" in str(p) or "frontend" in str(p) for p in written_paths)
