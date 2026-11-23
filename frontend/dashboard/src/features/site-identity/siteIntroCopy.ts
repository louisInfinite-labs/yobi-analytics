import type { Locale } from "../../shared/i18n/translations"

/** The text of Home's "About OshiYobi" section (HomeSiteIntro), in the app's three languages. Kept beside the component rather than in the shared
 * translation table: the section is one self-contained block of site description, and it can then ship without touching that shared table. Every
 * sentence describes a feature as it exists (Live Status, the schedule page, the video list and its unwatched-new-content count, Settings' Oshi and notification
 * options); nothing here claims live data. UI names match the labels the app itself shows in each language. */
export interface SiteIntroCopy {
  heading: string
  lead: string
  liveStatus: string
  /** Rendered as: <link>{scheduleLink}</link>{scheduleText} */
  scheduleLink: string
  scheduleText: string
  videos: string
  settingsLink: string
  settingsText: string
  aboutLink: string
  /** Home's live line (HomeSiteHeading), from the /live-streams data the page already has: before that data has answered (or when it failed). */
  liveUnknown: string
  /** The data answered and nobody is live. */
  liveNone: string
  liveNow: (count: number, names: string) => string
  moreNames: (count: number) => string
  nameSeparator: string
  upcoming: (count: number) => string
}

export const SITE_INTRO_COPY: Record<Locale, SiteIntroCopy> = {
  "zh-TW": {
    heading: "關於 OshiYobi",
    lead: "OshiYobi 把 Hololive 與 VSPO 創作者的直播、新影片和直播預告整理在同一個地方。",
    liveStatus: "直播狀態：用右下角的按鈕打開，查看誰正在直播或即將開播，並切換到任何創作者。",
    scheduleLink: "直播時間表",
    scheduleText: "：按日期列出即將開始與直播中的節目。",
    videos: "影片清單：依主題瀏覽近期影片與直播；「尚未觀看」會統計你還沒看過的新影片與直播。",
    settingsLink: "設定",
    settingsText: "：選擇你的推し，並開啟直播與新影片通知。",
    aboutLink: "進一步了解 OshiYobi",
    liveUnknown: "直播中：—",
    liveNone: "目前沒有創作者在直播。",
    liveNow: (count, names) => `直播中（${count}）：${names}`,
    moreNames: (count) => `等另外 ${count} 位`,
    nameSeparator: "、",
    upcoming: (count) => `24 小時內開播：${count} 位`,
  },
  en: {
    heading: "About OshiYobi",
    lead: "OshiYobi brings livestreams, new videos and upcoming-stream schedules from Hololive and VSPO creators together in one place.",
    liveStatus: "Live Status: open it with the button at the bottom right to see who is live or about to go live, and switch to any creator.",
    scheduleLink: "Live Schedule",
    scheduleText: ": upcoming and ongoing streams, laid out by day.",
    videos: "Video list: recent videos and streams by topic. “Not watched yet” counts the new videos and streams you haven’t watched.",
    settingsLink: "Settings",
    settingsText: ": choose your Oshi and turn on live and new-video notifications.",
    aboutLink: "More about OshiYobi",
    liveUnknown: "Live now: —",
    liveNone: "No creator is live right now.",
    liveNow: (count, names) => `Live now (${count}): ${names}`,
    moreNames: (count) => `and ${count} more`,
    nameSeparator: ", ",
    upcoming: (count) => `Starting within 24 hours: ${count}`,
  },
  ja: {
    heading: "OshiYobi について",
    lead: "OshiYobi は、ホロライブとぶいすぽっ！のクリエイターの配信・新着動画・配信予定をひとつにまとめて確認できるサービスです。",
    liveStatus: "配信ステータス：右下のボタンで開き、配信中・まもなく配信のクリエイターを確認したり、見たいクリエイターに切り替えたりできます。",
    scheduleLink: "配信スケジュール",
    scheduleText: "：これからの配信と配信中の番組を日ごとに表示します。",
    videos: "動画リスト：最近の動画と配信をトピック別に表示します。「未視聴」では、まだ見ていない新着の動画と配信の数を確認できます。",
    settingsLink: "設定",
    settingsText: "：推しの選択や、配信・新着動画の通知を設定できます。",
    aboutLink: "OshiYobi についてもっと見る",
    liveUnknown: "配信中：—",
    liveNone: "現在配信中のクリエイターはいません。",
    liveNow: (count, names) => `配信中（${count}）：${names}`,
    moreNames: (count) => `ほか${count}人`,
    nameSeparator: "、",
    upcoming: (count) => `24時間以内に配信予定：${count}人`,
  },
}
