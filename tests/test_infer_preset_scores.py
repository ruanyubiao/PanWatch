"""保存的条件名里带评分后缀（用户 2026-11-05 第 1/2 条）。

两条要求：**已保存的条件**要补上分数、**新推理出来的条件**保存时也要带分数。
后缀格式 ``_999_778``（两段）；单段分析只有一位 ``_716``。已经带后缀的不重复追加。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from src.modules.market.fork_infer import search

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- 后缀格式
def test_两段评分用下划线拼后缀():
    assert search._score_suffix({"scores": {"train": {"score": 99.9}, "test": {"score": 77.8}}}) \
        == "_999_778"


def test_只有一段评分时也能给后缀():
    """单段分析（已经没有测试段了）不该因为缺 test 就整个后缀消失。"""
    assert search._score_suffix({"scores": {"train": {"score": 71.6}}}) == "_716"


def test_评分缺失返回空串():
    assert search._score_suffix({}) == ""
    assert search._score_suffix({"scores": {"train": {"score": None}}}) == ""


def test_已经带后缀不重复追加():
    scores = {"train": {"score": 71.6}, "test": {"score": 49.1}}
    assert search.scored_name("r11050610", scores) == "r11050610_716_491"
    assert search.scored_name("r11050610_716_491", scores) == "r11050610_716_491"


def test_自带数字的旧名字不会被当成已带后缀():
    """``base_1`` 这类名字必须以 2 位以上数字才认作后缀，否则会被跳过。"""
    scores = {"train": {"score": 55.0}}
    assert search.scored_name("base_1", scores) == "base_1_550"


# ---------------------------------------------------------------- 调度器改名
def _preset(dir_: Path, name: str, rule: dict | None = None) -> Path:
    dir_.mkdir(parents=True, exist_ok=True)
    path = dir_ / f"{name}.json"
    path.write_text(json.dumps({"name": name, "request": {"rule": rule or {"type": "group"},
                                                          "trading_days": 30}}),
                    encoding="utf-8")
    return path


def test_轮次跑完后把基础条件名补上评分(tmp_path, monkeypatch):
    scheduler = _load("scheduler_scores", "scripts/infer_scheduler.py")
    presets = tmp_path / "presets"
    monkeypatch.setattr(scheduler, "PRESET_DIR", str(presets))
    _preset(presets, "r11050610", {"type": "group", "id": "keep-me"})
    state = {"starts": [{"run_id": "run-1", "preset": "r11050610"}]}
    runs = [{"run_id": "run-1", "status": "done",
             "score_train": 71.6, "score_test": 49.1}]

    scheduler.rename_preset_with_scores(runs, state)

    assert not (presets / "r11050610.json").exists()
    renamed = presets / "r11050610_716_491.json"
    assert renamed.exists()
    body = json.loads(renamed.read_text(encoding="utf-8"))
    assert body["name"] == "r11050610_716_491"
    # 规则内容不能被动到
    assert body["request"]["rule"] == {"type": "group", "id": "keep-me"}
    assert state["renamed"]["run-1"] == "r11050610_716_491"


def test_没有评分就不改名(tmp_path, monkeypatch):
    scheduler = _load("scheduler_scores2", "scripts/infer_scheduler.py")
    presets = tmp_path / "presets"
    monkeypatch.setattr(scheduler, "PRESET_DIR", str(presets))
    _preset(presets, "r11050610")
    state = {"starts": [{"run_id": "run-1", "preset": "r11050610"}]}

    scheduler.rename_preset_with_scores([{"run_id": "run-1", "status": "done"}], state)

    assert (presets / "r11050610.json").exists()
    assert "renamed" not in state


def test_改名是幂等的(tmp_path, monkeypatch):
    scheduler = _load("scheduler_scores3", "scripts/infer_scheduler.py")
    presets = tmp_path / "presets"
    monkeypatch.setattr(scheduler, "PRESET_DIR", str(presets))
    _preset(presets, "e11051525")
    state = {"starts": [{"run_id": "run-1", "preset": "e11051525"}]}
    runs = [{"run_id": "run-1", "status": "done", "score_train": 52.0, "score_test": 61.0}]

    scheduler.rename_preset_with_scores(runs, state)
    scheduler.rename_preset_with_scores(runs, state)

    names = sorted(path.stem for path in presets.glob("*.json"))
    assert names == ["e11051525_520_610"]


# ---------------------------------------------------------------- 一次性迁移
def test_迁移脚本给已有条件补分数(tmp_path, monkeypatch):
    script = _load("preset_scores", "scripts/preset_scores.py")
    preset_dir = tmp_path / "presets"
    infer_dir = tmp_path / "infer_runs"
    analysis_dir = tmp_path / "analysis_runs"
    for path in (infer_dir, analysis_dir):
        path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(script, "PRESET_DIR", preset_dir)
    monkeypatch.setattr(script, "INFER_DIR", infer_dir)
    monkeypatch.setattr(script, "ANALYSIS_DIR", analysis_dir)

    _preset(preset_dir, "r11050610")
    _preset(preset_dir, "base_1")          # 没有评分记录，保持原名
    _preset(preset_dir, "e11051525_716_491")  # 已带后缀，跳过
    run = infer_dir / "20261105-061033-27hz"
    run.mkdir()
    (run / "meta.json").write_text(json.dumps({
        "run_id": run.name, "preset": "r11050610", "status": "done",
        "finished_at": "2026-11-05T06:10:33",
        "scores": {"train": {"score": 71.6}, "test": {"score": 49.1}},
    }), encoding="utf-8")
    other = analysis_dir / "base_1" / "20261104-174530-02f8"
    other.mkdir(parents=True)
    (other / "meta.json").write_text(json.dumps({
        "run_id": other.name, "status": "done", "finished_at": "2026-11-04T17:45:30",
        "scores": {"train": {"score": 55.0}},
    }), encoding="utf-8")

    todo, unknown = script.plan()
    pairs = {item["old"]: item["new"] for item in todo}
    assert pairs == {"r11050610": "r11050610_716_491", "base_1": "base_1_550"}
    assert unknown == []

    script.apply(todo)

    names = sorted(path.stem for path in preset_dir.glob("*.json"))
    assert names == ["base_1_550", "e11051525_716_491", "r11050610_716_491"]


# ---------------------------------------------------------------- 免登录兜底
def test_关掉应用层登录时用空token继续(tmp_path, monkeypatch):
    """服务器上应用登录被关掉（auth_not_configured）时不能把整轮调度判成 api_unreachable。"""
    scheduler = _load("scheduler_login", "scripts/infer_scheduler.py")
    monkeypatch.setattr(scheduler, "API", "http://api.test")
    cred = tmp_path / ".agent_api.json"
    cred.write_text(json.dumps({"username": "admin", "password": "x"}), encoding="utf-8")
    monkeypatch.setattr(scheduler, "CRED_FILE", str(cred))
    monkeypatch.setattr(scheduler, "LOG_FILE", str(tmp_path / "s.log"))

    class _Err:
        code = 400

        def read(self) -> bytes:
            return b'{"code":400,"error_code":"auth_not_configured","message":"\xe8\xaf\xb7\xe5\x85\x88\xe8\xae\xbe\xe7\xbd\xae\xe8\xb4\xa6\xe5\x8f\xb7"}'

        def __enter__(self):
            raise AssertionError("不应走到这里")

        def __exit__(self, *a):
            return False

        def close(self):
            return None

    def fake_urlopen(req, timeout=0):
        raise scheduler.urllib.error.HTTPError("http://api.test/api/auth/login", 400,
                                               "Bad Request", {}, _Err())

    monkeypatch.setattr(scheduler.urllib.request, "urlopen", fake_urlopen)
    assert scheduler._login() == ""
    # 空 token 不能发 "Bearer " 头
    assert scheduler._headers("") == {}
    assert scheduler._headers("abc") == {"Authorization": "Bearer abc"}


def test_自动保存用轮次自己的时间戳命名():
    """同一个 tick 里保存多个轮次时，名字要能看出是哪一轮（不能全是 p11051755）。"""
    scheduler = _load("scheduler_stamp", "scripts/infer_scheduler.py")
    assert scheduler._run_stamp("20261105-061033-27hz") == "11050610"
    assert scheduler._run_stamp("20261102-082002-8aii") == "11020820"
    assert len(scheduler._run_stamp("")) == 8
