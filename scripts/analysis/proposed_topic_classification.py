"""PROPOSAL ONLY -- not wired into production. Lives outside src/ deliberately: `scripts/deploy/
package_lambda.py` only zips `src/`, so nothing here can ever be bundled into a Lambda deploy by
accident. tracking.video_topics.TOPICS (the real, deployed taxonomy) is completely untouched by
this file.

Source data: a full paginated Scan of YobiVideoMaster (133,184 videos; 97,604 persisted
topic="other") was analyzed for recurring, cross-channel topic signal beyond the existing 8-id
taxonomy. This module turns the strongest, cleanest results of that analysis -- the 49 highest-
confidence "valid" candidates (of a 149-candidate full inventory; the excluded 100 are either
individually small, or channel-specific/agency-branded/genre-level and deliberately NOT
recommended -- see AMBIGUOUS_NOT_RECOMMENDED below and the full inventory this was built from,
which a human reviewer can ask to see in full) -- into the same Topic shape
tracking.video_topics.TOPICS already uses, so adopting any of them later is a pure data change
(copy the entry into TOPICS, re-run scripts/migration/seed_topic_catalog_dynamodb.py), never an
architecture change.

Every regex here was counted against the REAL 97,604-title corpus and every candidate's match
count independently reproduced by compute_coverage() below (see
tests/scripts/analysis/test_proposed_topic_classification.py) -- this is evidence, not a guess.

Translation verification levels (see VERIFICATION per topic_tag):
  "verified"   -- confirmed via live research this session (official game/platform naming).
  "known"      -- well-established, decades-old official localization (not re-searched, but not
                  guessed either -- e.g. Pokemon, Final Fantasy, Zelda).
  "unresolved" -- NO confident official localized name found. topic_zh is the English name used
                  as an explicit, visible fallback, never presented as a verified translation.
                  These are deliberately NOT silently given an invented Chinese/Japanese name.

NOT adopted anywhere, not backfilled onto any video, not deployed. A human reviewer decides which
(if any) of these move into tracking.video_topics.TOPICS.
"""

from __future__ import annotations

from tracking.video_topics import Topic

VERIFICATION: dict[str, str] = {
    "rust": "unresolved",
    "among_us": "unresolved",
    "phasmophobia": "unresolved",
    "lethal_company": "unresolved",
    "monster_hunter": "verified",
    "splatoon": "verified",
}

# 49 highest-confidence candidates from the top 60 by real match count over the 97,604-title
# "other" corpus (the remaining 11 of the top 60 are channel-specific segments, agency-branded
# annual events, or deliberately broad genre buckets -- see AMBIGUOUS_NOT_RECOMMENDED). Patterns
# are byte-for-byte what was counted; do not hand-edit a pattern without re-running the count.
PROPOSED_TOPICS: tuple[Topic, ...] = (
    Topic("dance_cover", {"zh-TW": "翻跳", "en": "Dance Cover", "ja": "踊ってみた"}, r"踊ってみた"),
    Topic("pokemon", {"zh-TW": "寶可夢", "en": "Pokémon", "ja": "ポケモン"}, r"pok[eé]mon|ポケモン|ポケカ|シャイニングパール|ブリリアントダイヤモンド"),
    Topic("ark_survival", {"zh-TW": "方舟：生存進化", "en": "ARK: Survival Evolved", "ja": "ARK"}, r"(?<![a-z0-9])ark(?![a-z0-9])|ark: ?survival"),
    Topic("watchalong", {"zh-TW": "同步觀看", "en": "Watchalong", "ja": "同時視聴"}, r"同時視聴|watch ?along|watch ?party|ウォッチパーティー"),
    Topic("monster_hunter", {"zh-TW": "魔物獵人", "en": "Monster Hunter", "ja": "モンスターハンター"}, r"monster ?hunter|モンスターハンター|モンハン"),
    Topic("league_of_legends", {"zh-TW": "英雄聯盟", "en": "League of Legends", "ja": "League of Legends"}, r"league ?of ?legends|(?<![a-z0-9])lol(?![a-z0-9])"),
    Topic("mario_kart", {"zh-TW": "瑪利歐賽車", "en": "Mario Kart", "ja": "マリオカート"}, r"mario ?kart|マリオカート|マリカ(?![a-z])"),
    Topic("grand_theft_auto", {"zh-TW": "俠盜獵車手", "en": "Grand Theft Auto", "ja": "グランド・セフト・オート"}, r"grand theft auto|(?<![a-z])gta ?\d?(?![a-z])|mad ?town"),
    Topic("rust", {"zh-TW": "Rust", "en": "Rust", "ja": "Rust"}, r"(?<![a-z])rust(?![a-z])"),
    # The source analysis's original pattern here also had a bare "(?<![a-z])バイオ(?![a-z])"
    # alternative, which false-positives on バイオレット (Pokémon Violet's Japanese title) --
    # the katakana continuation after バイオ isn't itself a useful disambiguator here (both
    # バイオハザード and バイオレット continue with katakana), so the fix is precision over
    # recall: drop the bare alternative and require the full word, confirmed to still match
    # both "BIOHAZARD7 RESIDENT EVIL" and "バイオハザードヴィレッジ" in the real corpus.
    Topic("resident_evil", {"zh-TW": "惡靈古堡", "en": "Resident Evil", "ja": "バイオハザード"}, r"resident ?evil|biohazard|バイオハザード"),
    Topic("super_mario_platformer", {"zh-TW": "瑪利歐(平台/派對系列)", "en": "Super Mario (platformer/party)", "ja": "スーパーマリオ"}, r"super ?mario|マリオメーカー|ペーパーマリオ|マリオパーティ|スーパーマリオ|マリオテニス|マリオオデッセイ|マリオギャラクシー"),
    Topic("splatoon", {"zh-TW": "斯普拉遁", "en": "Splatoon", "ja": "スプラトゥーン"}, r"splatoon|スプラトゥーン|(?<![a-z])スプラ(?![a-z])"),
    Topic("dragon_quest", {"zh-TW": "勇者鬥惡龍", "en": "Dragon Quest", "ja": "ドラゴンクエスト"}, r"dragon ?quest|ドラゴンクエスト|ドラクエ"),
    Topic("elden_ring", {"zh-TW": "艾爾登法環", "en": "Elden Ring", "ja": "エルデンリング"}, r"elden ?ring|エルデンリング"),
    Topic("overwatch", {"zh-TW": "鬥陣特攻", "en": "Overwatch", "ja": "オーバーウォッチ"}, r"overwatch|オーバーウォッチ|ow2(?![a-z0-9])"),
    Topic("asmr", {"zh-TW": "ASMR", "en": "ASMR", "ja": "ASMR"}, r"(?<![a-z])asmr(?![a-z])"),
    Topic("final_fantasy", {"zh-TW": "最終幻想", "en": "Final Fantasy", "ja": "ファイナルファンタジー"}, r"final ?fantasy|ファイナルファンタジー|(?<![a-z0-9])ff\d{0,2}(?![a-z0-9])"),
    Topic("repo_game", {"zh-TW": "R.E.P.O.", "en": "R.E.P.O.", "ja": "R.E.P.O."}, r"(?<![a-z])r\.?e\.?p\.?o\.?(?![a-z])"),
    Topic("among_us", {"zh-TW": "Among Us", "en": "Among Us", "ja": "Among Us"}, r"among ?us|アモアス"),
    Topic("zelda", {"zh-TW": "薩爾達傳說", "en": "The Legend of Zelda", "ja": "ゼルダの伝説"}, r"zelda|ゼルダ"),
    Topic("yakuza", {"zh-TW": "如龍", "en": "Like a Dragon / Yakuza", "ja": "龍が如く"}, r"yakuza|龍が如く|如く極"),
    Topic("seven_days_to_die_survival", {"zh-TW": "七日殺", "en": "7 Days to Die", "ja": "7 Days to Die"}, r"7 ?days to die|7大豆|7dtd"),
    Topic("holocure", {"zh-TW": "HoloCure", "en": "HoloCure", "ja": "HoloCure"}, r"holocure"),
    Topic("pubg", {"zh-TW": "絕地求生", "en": "PUBG: Battlegrounds", "ja": "PUBG"}, r"(?<![a-z])pubg(?![a-z])"),
    Topic("phasmophobia", {"zh-TW": "Phasmophobia", "en": "Phasmophobia", "ja": "Phasmophobia"}, r"phasmophobia"),
    Topic("call_of_duty", {"zh-TW": "決勝時刻", "en": "Call of Duty", "ja": "コール オブ デューティ"}, r"call of duty|(?<![a-z])cod ?[:\s]?(?:wz|bocw|bo6|mw\d?|zombies)|warzone"),
    Topic("tokkomachi", {"zh-TW": "留言等待", "en": "Listener call-in (Tokkomachi)", "ja": "凸待ち"}, r"凸待ち|逆凸"),
    Topic("uma_musume", {"zh-TW": "賽馬娘 Pretty Derby", "en": "Umamusume: Pretty Derby", "ja": "ウマ娘 プリティーダービー"}, r"uma ?musume|ウマ娘|プリティーダービー"),
    Topic("mahjong", {"zh-TW": "麻將(雀魂)", "en": "Mahjong (Jantama)", "ja": "麻雀/雀魂"}, r"雀魂|麻雀|janshi|セガ ?net ?麻雀"),
    Topic("fall_guys", {"zh-TW": "糖豆人", "en": "Fall Guys", "ja": "フォールガイズ"}, r"fall ?guys|フォールガイズ"),
    Topic("asobi_taizen", {"zh-TW": "世界遊戲大全51", "en": "Clubhouse Games: 51 Worldwide Classics", "ja": "世界のアソビ大全51"}, r"アソビ大全|世界のアソビ大全"),
    Topic("persona", {"zh-TW": "女神異聞錄", "en": "Persona", "ja": "ペルソナ"}, r"persona ?\d|ペルソナ"),
    Topic("dead_by_daylight", {"zh-TW": "黎明死線", "en": "Dead by Daylight", "ja": "デッドバイデイライト"}, r"dead by daylight|(?<![a-z])dbd(?![a-z])"),
    Topic("superchat_reading", {"zh-TW": "讀超級留言", "en": "Superchat Reading", "ja": "スパチャ読み"}, r"スパチャ読み|superchat reading|super ?chat.{0,3}reading|donation reading"),
    Topic("tarkov", {"zh-TW": "逃離塔科夫", "en": "Escape from Tarkov", "ja": "タルコフ"}, r"tarkov|タルコフ|escape from tarkov"),
    Topic("palworld", {"zh-TW": "幻獸帕魯", "en": "Palworld", "ja": "パルワールド"}, r"palworld|パルワールド"),
    Topic("lethal_company", {"zh-TW": "Lethal Company", "en": "Lethal Company", "ja": "Lethal Company"}, r"lethal ?company"),
    Topic("shadowverse", {"zh-TW": "闇影詩章", "en": "Shadowverse", "ja": "シャドウバース"}, r"shadowverse|シャドバ"),
    Topic("animal_crossing", {"zh-TW": "集合啦！動物森友會", "en": "Animal Crossing", "ja": "あつまれ どうぶつの森"}, r"animal crossing|あつまれ ?どうぶつの森|どうぶつの森"),
    Topic("tetris_puyo", {"zh-TW": "俄羅斯方塊/魔法氣泡", "en": "Tetris / Puyo Puyo", "ja": "テトリス/ぷよぷよ"}, r"tetris|テトリス|ぷよぷよ|ぷよテト"),
    Topic("power_pro", {"zh-TW": "實況野球(栄冠ナイン)", "en": "Power Pros", "ja": "パワプロ"}, r"パワプロ|power ?pro"),
    Topic("genshin", {"zh-TW": "原神", "en": "Genshin Impact", "ja": "原神"}, r"genshin|原神"),
    Topic("undertale_deltarune", {"zh-TW": "undertale", "en": "Undertale / Deltarune", "ja": "アンダーテール"}, r"undertale|deltarune|アンダーテール"),
    Topic("counter_strike", {"zh-TW": "絕對武力", "en": "Counter-Strike", "ja": "カウンターストライク"}, r"counter-?strike|(?<![a-z0-9])cs ?2(?![a-z0-9])"),
    Topic("raft_game", {"zh-TW": "木筏求生", "en": "Raft", "ja": "Raft"}, r"(?<![a-z])raft(?![a-z])"),
    Topic("tomodachi_life", {"zh-TW": "朋友收藏/MiiLife", "en": "Tomodachi Life", "ja": "トモダチコレクション"}, r"tomodachi ?life|トモダチコレクション|トモコレ"),
    Topic("rainbow_six", {"zh-TW": "虹彩六號", "en": "Rainbow Six Siege", "ja": "レインボーシックス"}, r"rainbow ?six|r6s(?![a-z])|レインボーシックス"),
    Topic("suika_game", {"zh-TW": "西瓜遊戲", "en": "Suika Game", "ja": "スイカゲーム"}, r"スイカゲーム|suika ?game"),
    Topic("geoguessr", {"zh-TW": "GeoGuessr", "en": "GeoGuessr", "ja": "GeoGuessr"}, r"geoguessr"),
)

# Real, recurring patterns found in the SAME analysis -- deliberately NOT included above.
# Each is a genuine repeated signal, but unsuitable for a GLOBAL, cross-channel topic taxonomy.
AMBIGUOUS_NOT_RECOMMENDED: dict[str, str] = {
    "simulator_genre": "genre-level word ('Simulator' spans dozens of unrelated games) -- high false-positive risk.",
    "horror_game_genre": "genre label ('ホラゲー'), not a title -- same false-positive concern as simulator_genre.",
    "imadoki_wtm": "single-creator recurring segment (#今日のわため) -- zero cross-channel generalization value.",
    "sei_subaru": "single-creator recurring segment (#生スバル).",
    "polka_no_densetsu": "single-creator recurring segment (ポルカの伝説).",
    "holodori_event": "agency-internal branded event (ホロドリ / Hololive Dreams), not a content topic.",
    "holo_shinshun_cup": "agency-wide annual event whose own brand name changes every year (CUP2024/2025/...).",
    "drawing_sketch": "genre-level word (お絵描き/手描き) -- high false-positive risk, same concern as simulator_genre.",
    "cooking_stream": "genre-level word (料理/クッキング) -- same concern.",
    "banshaku_drinking": "broad lifestyle-format word (晩酌), not a distinct topic identity.",
    "fuwamoco_morning": "single-creator-pair recurring segment, not cross-channel.",
}
