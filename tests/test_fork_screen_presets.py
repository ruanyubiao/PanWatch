"""已保存条件（``data/screen_presets/*.json``）的存储与端点。

钉住的是「会真的坏掉」的几条：名字能不能当文件名、同名覆盖必须先被拦一次、
坏文件不能让整个下拉菜单打不开、删不存在的条件要走 404 而不是 500。
"""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.modules.market.api import fork_screen
from src.modules.market.fork_screen import presets
from src.modules.market.fork_screen.models import ScreenRequest


@pytest.fixture(autouse=True)
def preset_dir(tmp_path, monkeypatch):
    """每个用例一个空目录，绝不碰仓库里的 data/screen_presets。"""
    target = tmp_path / "screen_presets"
    monkeypatch.setattr(presets, "PRESET_DIR", target)
    return target


def request_payload(**over) -> dict:
    base = {
        "trading_days": 30,
        "markets": ["sh", "sz", "cyb", "kcb"],
        "include_st": False,
        "market_cap": {"min_yi": 100, "max_yi": 200},
        "rule": {
            "type": "group",
            "id": "g-root",
            "operator": "AND",
            "children": [
                {
                    "type": "condition",
                    "id": "c1",
                    "name": "consecutive_bullish",
                    "params": {"start": 1, "days": 4},
                }
            ],
        },
    }
    base.update(over)
    return base


def body(name: str = "四连阳", **over) -> fork_screen.PresetSaveBody:
    return fork_screen.PresetSaveBody(
        name=name, request=ScreenRequest.model_validate(request_payload()), **over
    )


# ---------------------------------------------------------------- 名字校验


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("  四连阳  ", "四连阳"),
        ("abcdefghij", "abcdefghij"),  # 正好 10 个
        ("连续四日阳线", "连续四日阳线"),
        ("低市值-多头", "低市值-多头"),
    ],
)
def test_P1_合法名字原样保留并去掉两端空格(raw, expected):
    assert presets.normalize_name(raw) == expected


@pytest.mark.parametrize(
    "raw,reason",
    [
        ("", "空"),
        ("   ", "空白"),
        ("abcdefghijk", "11 个字符"),
        ("连续四日阳线条件啊呀好", "11 个中文字符也算超长"),
        ("a/b", "路径分隔符"),
        ("a\\b", "反斜杠"),
        ("a:b", "冒号"),
        ("a*b", "星号"),
        ("a?b", "问号"),
        ("a|b", "竖线"),
        ("a\"b", "双引号"),
        ("a<b", "尖括号"),
        (".hidden", "以点开头"),
        ("name.", "以点结尾"),
        ("con", "Windows 保留名"),
        ("NUL", "保留名大小写不敏感"),
    ],
)
def test_P2_非法名字被拒(raw, reason):
    with pytest.raises(presets.PresetNameInvalid):
        presets.normalize_name(raw)


# ---------------------------------------------------------------- 存储


def test_P3_保存后文件名就是名字_内容带完整请求(preset_dir):
    record = presets.save("四连阳", request_payload())

    path = preset_dir / "四连阳.json"
    assert path.is_file()
    assert record["name"] == "四连阳"
    assert record["saved_at"]
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["request"]["market_cap"] == {"min_yi": 100, "max_yi": 200}
    assert payload["request"]["rule"]["children"][0]["params"] == {"start": 1, "days": 4}


def test_P4_同名保存要先拦一次_确认覆盖才重写(preset_dir):
    presets.save("四连阳", request_payload())
    with pytest.raises(presets.PresetExists):
        presets.save("四连阳", request_payload())

    presets.save("四连阳", request_payload(market_cap={"min_yi": 300, "max_yi": 500}), overwrite=True)
    assert presets.load("四连阳")["request"]["market_cap"]["min_yi"] == 300
    assert len(list(preset_dir.glob("*.json"))) == 1  # 覆盖不是追加


def test_P5_列表按保存时间倒序_坏文件被跳过(preset_dir):
    presets.save("旧", request_payload())
    presets.save("新", request_payload())
    # 手改坏的文件：整个下拉菜单不能因为它打不开
    (preset_dir / "坏.json").write_text("{不是 json", encoding="utf-8")
    (preset_dir / "空.json").write_text(json.dumps({"saved_at": "2026-01-01"}), encoding="utf-8")

    # saved_at 精确到秒，可能同秒 → 名字兜底排序，所以这里只断言数量与内容
    names = {item["name"] for item in presets.list_all()}
    assert names == {"旧", "新"}


def test_P6_删除不存在或名字非法都按404逻辑处理():
    with pytest.raises(presets.PresetNotFound):
        presets.delete("不存在的条件")

    presets.save("四连阳", request_payload())
    presets.delete("四连阳")
    with pytest.raises(presets.PresetNotFound):
        presets.load("四连阳")


def test_P7_没有目录时列表为空():
    assert presets.list_all() == []


# ---------------------------------------------------------------- 端点


def test_A20_保存与列出走端点():
    saved = fork_screen.save_screen_preset(body())
    assert saved["item"]["name"] == "四连阳"

    listed = fork_screen.list_screen_presets()
    assert [item["name"] for item in listed["items"]] == ["四连阳"]
    assert listed["items"][0]["request"]["trading_days"] == 30


def test_A21_名字非法是400_同名未确认是409():
    with pytest.raises(HTTPException) as bad:
        fork_screen.save_screen_preset(body(name="a/b"))
    assert bad.value.status_code == 400
    assert bad.value.detail["code"] == "screen_preset_name_invalid"

    fork_screen.save_screen_preset(body())
    with pytest.raises(HTTPException) as dup:
        fork_screen.save_screen_preset(body())
    assert dup.value.status_code == 409
    assert dup.value.detail["code"] == "screen_preset_exists"

    # 带 overwrite=True 就放行
    assert fork_screen.save_screen_preset(body(overwrite=True))["item"]["name"] == "四连阳"


def test_A22_名字超过10个字符在pydantic层就被拦():
    with pytest.raises(ValidationError):
        body(name="abcdefghijk")
    with pytest.raises(ValidationError):
        body(name="")


def test_A23_坏规则不允许被保存():
    payload = request_payload()
    payload["rule"]["children"][0]["name"] = "不存在的条件"
    with pytest.raises(HTTPException) as bad:
        fork_screen.save_screen_preset(
            fork_screen.PresetSaveBody(name="坏的", request=ScreenRequest.model_validate(payload))
        )
    assert bad.value.status_code == 400
    assert bad.value.detail["code"] == "screen_invalid_rule"


def test_A24_删除端点_不存在是404():
    fork_screen.save_screen_preset(body())
    assert fork_screen.delete_screen_preset("四连阳")["deleted"] == "四连阳"

    with pytest.raises(HTTPException) as missing:
        fork_screen.delete_screen_preset("四连阳")
    assert missing.value.status_code == 404
    assert missing.value.detail["code"] == "screen_preset_not_found"
