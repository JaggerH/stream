import type { AudioPlayerLabels } from './acrylic/audio-player.tsx'
import type { AudioPlayerStageLabels } from './acrylic/audio-player-stage.tsx'

/** Chinese copy for the vendored acrylic audio players.
 *
 *  acrylic-ui is an English registry: both players default every aria-label and every visible
 *  empty-title fallback to English and take a `labels` override. Stream's UI is Chinese, so
 *  every `<AudioPlayer>` / `<AudioPlayerStage>` call site passes the dictionary below.
 *
 *  Kept OUT of components/acrylic/ on purpose — those two files are vendored copies that get
 *  re-synced from the registry, and anything app-specific left inside them has to survive a
 *  three-way merge every time. */

export const AUDIO_PLAYER_LABELS_ZH: AudioPlayerLabels = {
  previous: '上一首',
  play: '播放',
  pause: '暂停',
  next: '下一首',
  volume: '音量',
  nowPlaying: '播放中',
  openNowPlaying: '打开播放中：{title}',
}

export const AUDIO_PLAYER_STAGE_LABELS_ZH: AudioPlayerStageLabels = {
  collapse: '收起',
  enterFullscreen: '全屏',
  exitFullscreen: '退出全屏',
  previous: '上一首',
  play: '播放',
  pause: '暂停',
  next: '下一首',
  progress: '进度',
  volume: '音量',
  unknownTrack: '未知曲目',
}
