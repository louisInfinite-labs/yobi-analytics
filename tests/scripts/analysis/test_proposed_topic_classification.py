"""Focused tests for the PROPOSAL-ONLY module (scripts/analysis/proposed_topic_classification.py).
Nothing here touches tracking.video_topics.TOPICS or AWS -- these tests only prove the proposed
patterns actually match real production titles correctly, matching the same NFKC+casefold
convention classify_video_topic itself uses."""

import re
import unicodedata

import pytest

from scripts.analysis.proposed_topic_classification import AMBIGUOUS_NOT_RECOMMENDED, PROPOSED_TOPICS, VERIFICATION
from tracking.video_topics import TOPICS

# One real, verbatim title per candidate (from a full paginated Scan of YobiVideoMaster's
# topic="other" videos this session) -- NEVER fabricated. resident_evil's example was swapped
# after discovering its original source-analysis pattern false-positived on a Pokémon title that
# happened to share the string "バイオ" (see that Topic's own comment in proposed_topic_classification.py).
REAL_EXAMPLE_TITLES: dict[str, str] = {
    "dance_cover": "AZKiのお姉さまはどこ…？　 お姉さま♡ラヴコール / ラプラス・ダークネス 踊ってみた！#お姉さまラヴコール #ラプラスダークネス #AZKi #ホロライブ #hololive #shorts",
    "pokemon": "【ポケモンSV/バイオレット】　#６　SWITCH2！エリアゼロ初見で行くぞ～！！！　【ぶいすぽ / 猫汰つな】",
    "ark_survival": "【ホロ鯖ARK】拠点を整備しつつアルゲンやパイロメインに想いをはせる【白銀ノエル/ホロライブ】",
    "watchalong": "【ホロライブ】#ReGLOSS デビュー公式配信同時視聴【DAY2】",
    "monster_hunter": "【モンスターハンターサンブレイク】寄生虫育ちすぎかもです【ぶいすぽっ！/紫宮るな】",
    "league_of_legends": "【League of Legends】clash全然やったことないけどやってみるぞ！！！【 ぶいすぽっ！ / 千燈ゆうひ 】",
    "mario_kart": "【Switch2】マリオカートワールドの世界へいくぜぇえええええええええええええ！！！！！🏎【ホロライブ/さくらみこ】",
    "grand_theft_auto": "【GTA5│MAD TOWN】今日からはじまる白ギャングPart1【アキロゼ/ホロライブ】",
    "rust": "【RUST】ホロライブ花火大会！綺麗にデザインするやさん～！【ホロライブ/夏色まつり】",
    "resident_evil": "【BIOHAZARD7 RESIDENT EVIL】初めてのバイオハザードに挑戦する #1【ホロライブ/不知火フレア】",
    "super_mario_platformer": "【スーパーマリオブラザーズ】ゲームオーバーで即終了！クリア目指す！！！！！2日目！ぺこ！【ホロライブ/兎田ぺこら】",
    "splatoon": "【Splatoon2】🖌：ガチマッチであそぶ！【ぶいすぽ/胡桃のあ​】",
    "dragon_quest": "＃1【 ドラクエ11S  】ドラゴンクエストXI 過ぎ去りし時を求めて S で遊ぶのら！！！ 【姫森ルーナ/ホロライブ】ネタバレあり",
    "elden_ring": "◤  ELDEN RING ◢　＃5 エルデンリング続きやるぞ！   ◤ぶいすぽっ！ #龍巻ちせ ⁠◢",
    "overwatch": "【OVERWATCH】今日は本番相手（ＣＲ）とスクリム！　【ぶいすぽ / 猫汰つな】",
    "asmr": "【THREAT -SCREAM AND ESCAPE-】screaming asmr【Kaela Kovalskia / hololiveID】",
    "final_fantasy": "#5【 FF7 】完全初見！ファイナルファンタジー７オリジナル！※ネタバレあります【#綺々羅々ヴィヴィ #hololiveDEV_IS #FLOWGLOW】",
    "repo_game": "笑わせないでw【ホロライブ / AZKi】#ぷちあず #shorts #REPO #ホロREPO #協力ホラゲー",
    "among_us": "【AmongUs】発掘企画で見つけたみんなとだまし合い！？【ホロライブ/夏色まつり】",
    "zelda": "#09【ゼルダの伝説 ブレワイ】4つ目の神獣まで！！少し【ぶいすぽ/一ノ瀬うるは】",
    "yakuza": "≪YAKUZA 5≫ She's an Athlete ... First Playthrough!! #10 【SPOILER WARNING】",
    "seven_days_to_die_survival": "【#ホロ7DTD】ころね支店 ～ アホの１日目 ～【７Days To Die】",
    "holocure": "【 HoloCure 】ハードモードをクリアしてやるぜ！！【常闇トワ / ホロライブ】",
    "pubg": "【PUBG】弾を撃ちたい一ノ瀬うるは【新人VTuber】",
    "phasmophobia": "【PHASMOPHOBIA】Scurryyy",
    "call_of_duty": "【CoD:WZ】なんか今日ミッションあるらしい【ぶいすぽ/花芽なずな】",
    "tokkomachi": "【 ＃綺々羅々ヴィヴィ生誕祭2025 】初オンライン＆リアル凸待ち！🎂告知あり！【#綺々羅々ヴィヴィ #hololiveDEV_IS #FLOWGLOW】",
    "uma_musume": "【Umamusume Pretty Derby】IDK what I am doing but I am doing it 🐎 #CiaoRaora【GORILLA】",
    "mahjong": "【セガNET麻雀 MJ】はじめての麻雀！ホロライブカップ開催中！【ホロライブ / AZKi】",
    "fall_guys": "【#FallGuys】FOXBURGERKING　6th【ホロライブ/白上フブキ】",
    "asobi_taizen": "【世界のアソビ大全51】そらわたで対決だ！！【ホロライブ/ときのそら/角巻わため】",
    "persona": "#4【Persona 5 Royal】FOUR REAL!?!?!? (SPOILER ALERT)【Pavolia Reine/hololiveID 2nd gen】",
    "dead_by_daylight": "【HALLOWEEN EVENT 🎃】   First time Dead by Daylight! VSPO EN x JP 【#VSPOEN #RemiaAotsuki】",
    "superchat_reading": "【SUPERCHAT READING】superhero wawa appears! #kfp #キアライブ",
    "tarkov": "【EFT/タルコフ】貯金が2000万ルーブルいきそうって話【ぶいすぽ/神成きゅぴ】",
    "palworld": "【パルワールド】お空飛んで！新しいマップ広げるぞ～～～！✨【猫又おかゆ/ホロライブ】",
    "lethal_company": "【Lethal Company】let me learn this new game【Kaela & Anya / hololiveID】",
    "shadowverse": "【SHADOWVERSE: WORLDS BEYOND】SHOWDOWN vs Cecilia Immergreen! #ad #umamusume",
    "animal_crossing": "【あつまれ どうぶつの森】まったり生活しながらゆっくりしよう！【ホロライブ/ときのそら】",
    "tetris_puyo": "【テトリス99】第３回！視聴者参加型で一緒にテトリス特訓！！！【角巻わため/ホロライブ４期生】",
    "power_pro": "【パワプロ2026】1年目秋～このチーム大丈夫！？！！！！！！最新作！栄冠ナイン3年縛りで遊ぼ～～～う！！✨【一条莉々華/hololive DEV_IS ReGLOSS】",
    "genshin": "【 原神 】#6 俺たちはいずれ再会する。【 ぶいすぽっ！ / 小森めと 】",
    "undertale_deltarune": "【UNDERTALE】#4 噂のGルートとやら 完全初見ネタバレ禁止【ぶいすぽっ！/花芽すみれ】",
    "counter_strike": "【CS2】スクリム２日目－がんばれチルえいむ【ぶいすぽ/花芽なずな】",
    "raft_game": "【Raft】イカダが超発展しているらしい！！？#海犬フレンズ【沙花叉クロヱ/ホロライブ】",
    "tomodachi_life": "【Tomodachi Life】Improving Residents Quality of Life【Pavolia Reine/hololiveID】",
    "rainbow_six": "【R6E】奪い返しにIKZO！レインボーシックスエクストラクション【鷹嶺ルイ視点/ホロライブ】",
    "suika_game": "【スイカゲーム】totally not addicted to the fruits 🍉【Kaela Kovalskia / hololiveID】",
    "geoguessr": "【🏠オフコラボ】ｴｯﾎｴｯﾎ✈　world　GeoGuessr　🌎👀【ホロライブ/ #ろぼいなぁず】",
}


def _normalize(title: str) -> str:
    return unicodedata.normalize("NFKC", title).casefold()


def test_every_proposed_topic_has_an_example_title():
    missing = [topic.id for topic in PROPOSED_TOPICS if topic.id not in REAL_EXAMPLE_TITLES]
    assert not missing, f"no real example title on file for: {missing}"


@pytest.mark.parametrize("topic", PROPOSED_TOPICS, ids=lambda t: t.id)
def test_each_proposed_pattern_matches_its_own_real_example_title(topic):
    example = REAL_EXAMPLE_TITLES[topic.id]
    pattern = re.compile(topic.pattern)
    assert pattern.search(_normalize(example)), f"{topic.id}'s pattern does not match its own real example title"


@pytest.mark.parametrize("topic", PROPOSED_TOPICS, ids=lambda t: t.id)
def test_each_proposed_topic_has_a_complete_labels_dict(topic):
    assert set(topic.labels) == {"zh-TW", "en", "ja"}
    assert all(topic.labels[locale] for locale in ("zh-TW", "en", "ja"))


def test_every_proposed_topic_was_activated_into_the_deployed_taxonomy():
    """This proposal's 49 candidates were reviewed and merged into tracking.video_topics.TOPICS
    (Topic Discovery batch 1) -- this confirms every one made it in, with the exact same labels/
    pattern, not just a same-named-but-different entry."""
    deployed_by_id = {t.id: t for t in TOPICS}
    for proposed in PROPOSED_TOPICS:
        assert proposed.id in deployed_by_id, f"{proposed.id} is missing from the deployed taxonomy"
        deployed = deployed_by_id[proposed.id]
        assert deployed.labels == proposed.labels
        assert deployed.pattern == proposed.pattern


def test_no_proposed_topic_id_collides_with_itself_or_the_ambiguous_set():
    proposed_ids = [t.id for t in PROPOSED_TOPICS]
    assert len(proposed_ids) == len(set(proposed_ids)), "duplicate id in PROPOSED_TOPICS"
    assert set(proposed_ids).isdisjoint(AMBIGUOUS_NOT_RECOMMENDED)


def test_every_verification_entry_refers_to_a_real_proposed_topic():
    proposed_ids = {t.id for t in PROPOSED_TOPICS}
    assert set(VERIFICATION).issubset(proposed_ids)


def test_resident_evil_pattern_does_not_false_positive_on_pokemon_violet():
    """Regression test for a real bug found while building this proposal: the source
    analysis's original resident_evil pattern included a bare katakana "バイオ" alternative
    that also matched "バイオレット" (Pokémon Violet's Japanese title) -- fixed by requiring
    the full word. This title is a real production title, verbatim."""
    resident_evil = next(t for t in PROPOSED_TOPICS if t.id == "resident_evil")
    pokemon_title = "【ポケモンSV/バイオレット】　#６　SWITCH2！エリアゼロ初見で行くぞ～！！！　【ぶいすぽ / 猫汰つな】"

    assert not re.compile(resident_evil.pattern).search(_normalize(pokemon_title))

    pokemon = next(t for t in PROPOSED_TOPICS if t.id == "pokemon")
    assert re.compile(pokemon.pattern).search(_normalize(pokemon_title))
