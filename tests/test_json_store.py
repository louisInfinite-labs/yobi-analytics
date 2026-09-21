import os
import subprocess
import sys
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"


def _data_dir(env_value):
    env = {k: v for k, v in os.environ.items() if k != "YOBI_DATA_DIR"}
    if env_value is not None:
        env["YOBI_DATA_DIR"] = env_value
    result = subprocess.run(
        [sys.executable, "-c", "from stores.json_store import DATA_DIR; print(DATA_DIR)"],
        cwd=SRC_DIR,
        env={**env, "PYTHONPATH": str(SRC_DIR)},
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_data_dir_falls_back_to_src_when_env_unset_or_blank():
    assert _data_dir(None) == str(SRC_DIR)
    assert _data_dir("") == str(SRC_DIR)


def test_data_dir_uses_env_override(tmp_path):
    assert _data_dir(str(tmp_path)) == str(tmp_path)
