import { useAudioStage } from '../lib/audioStage.ts'
import { useAudioTime } from '../lib/audioTime.ts'
import { useSidebar } from './acrylic/sidebar.tsx'
import { AudioPlayer } from './acrylic/audio-player.tsx'
import { AUDIO_PLAYER_LABELS_ZH } from './audioPlayerLabels.ts'

/** Persistent now-playing chip for the sidebar footer. audioStage plays globally but the full
 *  <NowPlayingBar> only mounts on the music page — this keeps the current track + play/pause +
 *  progress visible from *other* pages. Renders nothing when idle, when `hidden` (on the music
 *  page, where the full transport already shows), or when the sidebar is collapsed to its icon
 *  rail (too narrow for the chip — a cover-only stub isn't a usable player). `onOpen` navigates
 *  to the music page. */
export function SidebarNowPlaying({ onOpen, hidden = false }: { onOpen: () => void; hidden?: boolean }) {
  const stage = useAudioStage()
  // subscribed, not read off the stage context — this chip is a leaf, so its own 1Hz re-render
  // is cheap; broadcasting the tick through the stage would drag the whole page along with it
  const currentTime = useAudioTime()
  const { state } = useSidebar()
  const { current } = stage
  if (hidden || !current || state === 'collapsed') return null

  return (
    <div className="px-2 pb-1">
      <AudioPlayer
        variant="mini"
        labels={AUDIO_PLAYER_LABELS_ZH}
        track={{ title: current.title || '播放中', artist: current.author, cover: current.poster }}
        playing={stage.playing}
        currentTime={currentTime}
        duration={stage.duration}
        onToggle={stage.toggle}
        onSeek={stage.seek}
        onOpen={onOpen}
      />
    </div>
  )
}
