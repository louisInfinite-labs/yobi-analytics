"""Hololive individual creators' canonical theme color is the FIRST `Image Color` on their Oshimark page.

Owner-approved source: https://www.oshimark.com/hololive/<creator>-memo (e.g. amanekanata-memo -> #76c0ea). The values
below were read from those pages (63 of the roster's 78 Hololive individuals have one) and compared with src/creators.json,
the backend canonical Creator Master. VSPO, official, group and staff channels have no approved source and are not covered.
"""

import json
from pathlib import Path

import pytest

from tracking.creator_master import THEME_COLOR_PATTERN, load_creators

CREATORS_JSON = Path(__file__).resolve().parents[2] / "src" / "creators.json"

OSHIMARK_FIRST_IMAGE_COLOR = {
    "tokino_sora": "#0146ea",  # ときのそら
    "robocosan": "#804e7f",  # ロボ子さん
    "azki": "#d11c76",  # AZKi
    "sakura_miko": "#fe4b74",  # さくらみこ
    "hoshimachi_suisei": "#2dcde4",  # 星街すいせい
    "aki_rosenthal": "#dc0485",  # アキ・ローゼンタール
    "akai_haato": "#d9062a",  # 赤井はあと
    "shirakami_fubuki": "#53c7ea",  # 白上フブキ
    "natsuiro_matsuri": "#ff5606",  # 夏色まつり
    "nakiri_ayame": "#ca223a",  # 百鬼あやめ
    "yuzuki_choco": "#dc5686",  # 癒月ちょこ
    "oozora_subaru": "#bde717",  # 大空スバル
    "ookami_mio": "#dc1935",  # 大神ミオ
    "nekomata_okayu": "#bf65e8",  # 猫又おかゆ
    "inugami_korone": "#dcb414",  # 戌神ころね
    "usada_pekora": "#65baea",  # 兎田ぺこら
    "shiranui_flare": "#dc3813",  # 不知火フレア
    "shirogane_noel": "#89939d",  # 白銀ノエル
    "houshou_marine": "#a72413",  # 宝鐘マリン
    "amane_kanata": "#76c0ea",  # 天音かなた
    "tsunomaki_watame": "#dbda89",  # 角巻わため
    "tokoyami_towa": "#a7a2ea",  # 常闇トワ
    "himemori_luna": "#db6cad",  # 姫森ルーナ
    "yukihana_lamy": "#48b5e3",  # 雪花ラミィ
    "momosuzu_nene": "#fe7a0f",  # 桃鈴ねね
    "shishiro_botan": "#5fcfa6",  # 獅白ぼたん
    "omaru_polka": "#ab0808",  # 尾丸ポルカ
    "laplus_darkness": "#441495",  # ラプラス・ダークネス
    "takane_lui": "#28040d",  # 鷹嶺ルイ
    "hakui_koyori": "#fe68ad",  # 博衣こより
    "kazama_iroha": "#44bfb7",  # 風真いろは
    "hiodoshi_ao": "#16264b",  # 火威青
    "otonose_kanade": "#f6c663",  # 音乃瀬奏
    "ichijou_ririka": "#ee558b",  # 一条莉々華
    "juufuutei_raden": "#1c5e4f",  # 儒烏風亭らでん
    "todoroki_hajime": "#9293fe",  # 轟はじめ
    "isaki_riona": "#c92654",  # 響咲リオナ
    "koganei_niko": "#f25e11",  # 虎金妃笑虎
    "mizumiya_su": "#64cce4",  # 水宮枢
    "rindo_chihaya": "#2c8c8b",  # 輪堂千速
    "kikirara_vivi": "#e34899",  # 綺々羅々ヴィヴィ
    "mori_calliope": "#a1020b",  # Mori Calliope
    "takanashi_kiara": "#dc3907",  # Takanashi Kiara
    "ninomae_inanis": "#3f3e69",  # Ninomae Ina'nis
    "irys": "#991150",  # IRyS
    "ouro_kronii": "#1d1797",  # Ouro Kronii
    "hakos_baelz": "#fe3a2d",  # Hakos Baelz
    "shiori_novella": "#8c80ae",  # Shiori Novella
    "koseki_bijou": "#4b43df",  # Koseki Bijou
    "nerissa_ravencroft": "#1e27ac",  # Nerissa Ravencroft
    "elizabeth_rose_bloodflame": "#97303a",  # Elizabeth Rose Bloodflame
    "gigi_murin": "#cd9328",  # Gigi Murin
    "cecilia_immergreen": "#137a42",  # Cecilia Immergreen
    "raora_panthera": "#e75786",  # Raora Panthera
    "ayunda_risu": "#ef8381",  # Ayunda Risu
    "moona_hoshinova": "#784dbe",  # Moona Hoshinova
    "airani_iofifteen": "#7bdf0e",  # Airani Iofifteen
    "kureiji_ollie": "#b7030e",  # Kureiji Ollie
    "anya_melfissa": "#e89c0f",  # Anya Melfissa
    "pavolia_reine": "#040f7f",  # Pavolia Reine
    "vestia_zeta": "#97a1ae",  # Vestia Zeta
    "kaela_kovalskia": "#dc2528",  # Kaela Kovalskia
    "kobo_kanaeru": "#161c4f",  # Kobo Kanaeru
}

# Hololive individuals with no Oshimark page (graduated members and the newest debuts): no approved source exists, so
# their color is deliberately left as the roster has it (not guessed).
# Hololive individuals with no Oshimark page (graduated members and the newest debuts), with the color the roster
# already had for them. No approved source exists, so it is deliberately left exactly as it was (never guessed).
NO_OSHIMARK_PAGE_EXISTING_COLOR = {
    "yozora_mel": None,
    "minato_aqua": None,
    "murasaki_shion": None,
    "uruha_rushia": None,
    "kiryu_coco": None,
    "mano_aloe": None,
    "sakamata_chloe": None,
    "hyakuto_kyoko": "#F86701",
    "achichi_mela": "#1C97FF",
    "suzuna_tsuzuri": "#E2383B",
    "sorashina_sopia": "#7B7EFF",
    "gawr_gura": None,
    "watson_amelia": None,
    "ceres_fauna": None,
    "nanashi_mumei": None,
}
NO_OSHIMARK_PAGE = tuple(NO_OSHIMARK_PAGE_EXISTING_COLOR)

# Already stored as the (case-insensitively) correct value before this change, so their stored case was left alone;
# every other value was rewritten from Oshimark in lowercase #rrggbb.
ALREADY_CORRECT_BEFORE_THE_FIX = (
    "azki",
    "inugami_korone",
    "otonose_kanade",
    "ichijou_ririka",
    "juufuutei_raden",
    "todoroki_hajime",
    "koganei_niko",
    "mizumiya_su",
    "rindo_chihaya",
    "elizabeth_rose_bloodflame",
    "gigi_murin",
    "cecilia_immergreen",
    "raora_panthera",
    "pavolia_reine",
    "kaela_kovalskia",
)


def _hololive_individuals():
    return [c for c in load_creators() if c.organization == "hololive" and c.channel_type == "member"]


def test_amane_kanata_is_76c0ea():
    kanata = {c.creator_id: c for c in load_creators()}["amane_kanata"]

    assert kanata.theme_color.lower() == "#76c0ea"
    stored = {c["creatorId"]: c for c in json.loads(CREATORS_JSON.read_text(encoding="utf-8"))}["amane_kanata"]
    assert stored["themeColor"] == "#76c0ea"  # stored in lowercase #rrggbb


@pytest.mark.parametrize(
    ("creator_id", "expected"),
    [
        ("hoshimachi_suisei", "#2dcde4"),  # Hololive JP
        ("shirakami_fubuki", "#53c7ea"),  # Hololive JP (the old value was a different blue)
        ("takanashi_kiara", "#dc3907"),  # Hololive EN
        ("nerissa_ravencroft", "#1e27ac"),  # Hololive EN
        ("kobo_kanaeru", "#161c4f"),  # Hololive ID
        ("kureiji_ollie", "#b7030e"),  # Hololive ID
        ("hiodoshi_ao", "#16264b"),  # graduated, previously had no color at all
    ],
)
def test_representative_creators_use_their_oshimark_first_image_color(creator_id, expected):
    creators = {c.creator_id: c for c in load_creators()}

    assert creators[creator_id].theme_color.lower() == expected


def test_every_audited_hololive_individual_matches_oshimark():
    creators = {c.creator_id: c for c in load_creators()}

    assert set(OSHIMARK_FIRST_IMAGE_COLOR) == {c.creator_id for c in _hololive_individuals()} - set(NO_OSHIMARK_PAGE)
    for creator_id, expected in OSHIMARK_FIRST_IMAGE_COLOR.items():
        assert creators[creator_id].theme_color.lower() == expected, creator_id


def test_stored_values_are_lowercase_rrggbb_except_those_that_were_already_correct():
    stored = {c["creatorId"]: c for c in json.loads(CREATORS_JSON.read_text(encoding="utf-8"))}

    for creator_id, expected in OSHIMARK_FIRST_IMAGE_COLOR.items():
        if creator_id in ALREADY_CORRECT_BEFORE_THE_FIX:
            assert stored[creator_id]["themeColor"].lower() == expected, creator_id
        else:
            assert stored[creator_id]["themeColor"] == expected, creator_id


def test_every_hololive_individual_has_a_valid_color_or_is_a_documented_gap():
    for creator in _hololive_individuals():
        if creator.creator_id in NO_OSHIMARK_PAGE:
            continue  # no approved source; left as-is
        assert creator.theme_color is not None, creator.creator_id
        assert THEME_COLOR_PATTERN.fullmatch(creator.theme_color), creator.creator_id


def test_creators_without_an_oshimark_page_keep_exactly_the_color_they_had():
    stored = {c["creatorId"]: c for c in json.loads(CREATORS_JSON.read_text(encoding="utf-8"))}

    for creator_id, existing in NO_OSHIMARK_PAGE_EXISTING_COLOR.items():
        assert stored[creator_id].get("themeColor") == existing, creator_id
        assert creator_id not in OSHIMARK_FIRST_IMAGE_COLOR


def test_vspo_and_non_individual_channels_keep_their_existing_colors():
    creators = {c.creator_id: c for c in load_creators()}

    assert creators["sorasumi_sena"].theme_color == "#FFFFFF"  # VSPO, no Oshimark source
    assert creators["arya_kuroha"].theme_color == "#000000"
    for creator in load_creators():
        if creator.organization != "hololive" or creator.channel_type != "member":
            assert creator.creator_id not in OSHIMARK_FIRST_IMAGE_COLOR
