"""已保存条件的存储与端点。

2026-11-06 第 3 条：存储从 JSON 文件改成 MySQL（``panwatch.screen_preset``）。
单测不连库 —— ``conftest.py`` 的 autouse fixture 注入内存实现，所以这里断言的是
**接口行为**（同名不许静默覆盖、坏名字被拒、删不存在走 404、存储挂了走 503），
MySQL 自己的 SQL 由部署后的接口实测覆盖。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.modules.market.api import fork_screen
from src.modules.market.fork_screen import presets
from src.modules.market.fork_screen.models import ScreenRequest


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
        ("a" * 33, "33 个字符（上限 32）"),
        ("低" * 33, "33 个中文字符也算超长"),
        ("a/b", "路径分隔符"),
        ("a\\b", "反斜杠"),
        ("a:b", "冒号"),
        ("a*b", "星号"),
        ("a?b", "问号"),
        ("a|b", "竖线"),
        ('a"b', "双引号"),
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


def test_P3_保存后能原样读回_带完整请求():
    record = presets.save("四连阳", request_payload())

    assert record["name"] == "四连阳"
    assert record["saved_at"]
    loaded = presets.load("四连阳")
    assert loaded["request"]["market_cap"] == {"min_yi": 100, "max_yi": 200}
    assert loaded["request"]["rule"]["children"][0]["params"] == {"start": 1, "days": 4}


def test_P4_同名保存要先拦一次_确认覆盖才重写():
    presets.save("四连阳", request_payload())
    with pytest.raises(presets.PresetExists):
        presets.save("四连阳", request_payload())

    presets.save("四连阳", request_payload(market_cap={"min_yi": 300, "max_yi": 500}), overwrite=True)
    assert presets.load("四连阳")["request"]["market_cap"]["min_yi"] == 300
    assert len(presets.list_all()) == 1  # 覆盖不是追加


def test_P5_列表按保存时间倒序():
    presets.save("旧", request_payload())
    presets.save("新", request_payload())

    names = [item["name"] for item in presets.list_all()]
    assert names == ["新", "旧"]


def test_P6_删除不存在按404逻辑处理():
    with pytest.raises(presets.PresetNotFound):
        presets.delete("不存在的条件")

    presets.save("四连阳", request_payload())
    presets.delete("四连阳")
    with pytest.raises(presets.PresetNotFound):
        presets.load("四连阳")


def test_P7_空库返回空列表():
    assert presets.list_all() == []


def test_P8_名字后缀里的评分会解析出来():
    """列表页要显示分数 —— 分数只有名字后缀这一个来源（用户 2026-11-06 第 2 条）。"""
    presets.save("xg_999_778", request_payload())
    presets.save("base_716", request_payload())
    presets.save("无条件", request_payload())

    by_name = {item["name"]: item["scores"] for item in presets.list_all()}
    assert by_name["xg_999_778"] == (99.9, 77.8)
    assert by_name["base_716"] == (71.6,)
    assert by_name["无条件"] == ()


def test_P9_改名保留请求内容_同名目标被拒():
    presets.save("r11050610", request_payload())
    presets.save("占位", request_payload())

    renamed = presets.rename("r11050610", "r11050610_716_491")
    assert renamed["name"] == "r11050610_716_491"
    assert renamed["request"]["trading_days"] == 30
    assert renamed["scores"] == (71.6, 49.1)

    with pytest.raises(presets.PresetExists):
        presets.rename("r11050610_716_491", "占位")
    with pytest.raises(presets.PresetNotFound):
        presets.rename("不存在", "随便")


def test_P10_条件库连不上时抛存储错误而不是崩栈(_memory_preset_store):
    _memory_preset_store.broken = True
    with pytest.raises(presets.PresetStorageError):
        presets.list_all()
    with pytest.raises(presets.PresetStorageError):
        presets.save("四连阳", request_payload())


# ---------------------------------------------------------------- 端点


def test_A20_保存与列出走端点():
    saved = fork_screen.save_screen_preset(body())
    assert saved["item"]["name"] == "四连阳"
    assert saved["item"]["scores"] == ()

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


def test_A22_名字超过32个字符在pydantic层就被拦():
    """上限 32：要放得下「基础名_推理分_测试分」（如 xg_opt1_999_778）。"""
    with pytest.raises(ValidationError):
        body(name="a" * 33)
    assert body(name="xg_opt1_999_778").name == "xg_opt1_999_778"
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


def test_A25_条件库不可用时端点返回503(_memory_preset_store):
    _memory_preset_store.broken = True
    with pytest.raises(HTTPException) as down:
        fork_screen.list_screen_presets()
    assert down.value.status_code == 503
    assert down.value.detail["code"] == "screen_preset_store_unavailable"
