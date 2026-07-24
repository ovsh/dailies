import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api";
import type { FileDetail, Scene, TranscriptSegment } from "../../shared/types";
import { TimecodeText } from "../components/TimecodeText";
import { InlineError } from "../components/InlineError";
import { AudioGlyph } from "../components/AudioGlyph";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { runIpc } from "../lib/async";
import { isAudioOnly } from "../lib/media";

interface ClipScreenProps {
  fileId: number;
  seekS: number;
  onBack: () => void;
}

function formatDuration(durationS: number): string {
  const s = Math.round(durationS);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts = hh > 0 ? [hh, mm, ss] : [mm, ss];
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join(":");
}

export function ClipScreen({ fileId, seekS, onBack }: ClipScreenProps) {
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const result = await runIpc(
      () => api.getFileDetail(fileId),
      { setPending: setLoading, setError: setLoadError, fallback: "Could not load this clip." },
    );
    if (result.ok && generation === loadGeneration.current) setDetail(result.value);
  }, [fileId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [fileId, load]);

  useLiveRefresh(load);

  useEffect(() => {
    const media = audioRef.current ?? videoRef.current;
    if (detail && media) {
      media.currentTime = seekS;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, fileId, seekS]);

  function handleTimeUpdate() {
    const media = audioRef.current ?? videoRef.current;
    if (!media || !detail) return;
    const t = media.currentTime;
    const seg = detail.segments.find((s) => t >= s.startS && t < s.endS);
    setActiveSegmentId(seg?.id ?? null);
  }

  function seekTo(s: number) {
    const media = audioRef.current ?? videoRef.current;
    if (media) {
      media.currentTime = s;
      media.play().catch(() => {});
    }
  }

  if (!detail) {
    return (
      <div className="clip-screen">
        {loading && <p className="clip-loading mono">Loading…</p>}
        {loadError && (
          <div className="clip-loading-error">
            <InlineError message={loadError} onRetry={() => void load()} retrying={loading} />
            <button className="clip-back label" onClick={onBack}>← Back</button>
          </div>
        )}
      </div>
    );
  }

  const { file, playbackPath, scenes, segments } = detail;
  const audioOnly = isAudioOnly(file);
  const mediaSrc = mediaUrl(playbackPath);

  return (
    <div className="clip-screen">
      <header className="clip-header">
        <button className="clip-back label" onClick={onBack}>
          ← Back
        </button>
        <h1 className="display clip-title">{file.filename}</h1>
        <p className="clip-meta-line mono">
          {audioOnly ? (
            <><span className="clip-audio-chip label">Audio</span><span className="clip-meta-separator">·</span></>
          ) : file.fps > 0 ? (
            <>{file.fps.toFixed(3)} FPS <span className="clip-meta-separator">·</span></>
          ) : null}
          <TimecodeText tc={file.startTc} dim /> · {formatDuration(file.durationS)} · {file.codec} ·{" "}
          {file.role === "raw" ? "RAW" : "FINAL"}
        </p>
        {loadError && <InlineError message={loadError} onRetry={() => void load()} retrying={loading} />}
      </header>

      <div className="clip-body">
        <div className="clip-player-col">
          <div className={`clip-player-wrap${audioOnly ? " audio" : ""}${!playbackPath ? " unavailable" : ""}`}>
            {!playbackPath ? (
              <div className="clip-preview-unavailable mono">
                Original media can't be previewed in-app (MXF). Transcript timecodes still work.
              </div>
            ) : audioOnly ? (
              <div className="clip-audio-player">
                <div className="clip-audio-mark">
                  <AudioGlyph size={54} />
                  <span className="label">Audio source</span>
                </div>
                <audio
                  ref={audioRef}
                  className="clip-audio"
                  src={mediaSrc}
                  controls
                  aria-label={`Play ${file.filename}`}
                  onTimeUpdate={handleTimeUpdate}
                  onError={(e) => {
                    const err = e.currentTarget.error;
                    setLoadError(
                      err?.message
                        ? `Playback failed: ${err.message}`
                        : "This clip could not be played back.",
                    );
                  }}
                  onLoadedMetadata={() => {
                    if (audioRef.current) audioRef.current.currentTime = seekS;
                  }}
                />
              </div>
            ) : (
              <video
                ref={videoRef}
                className="clip-video"
                src={mediaSrc}
                controls
                onTimeUpdate={handleTimeUpdate}
                onError={(e) => {
                  const err = e.currentTarget.error;
                  setLoadError(
                    err?.message
                      ? `Playback failed: ${err.message}`
                      : "This clip could not be played back.",
                  );
                }}
                onLoadedMetadata={() => {
                  if (videoRef.current) videoRef.current.currentTime = seekS;
                }}
              />
            )}
          </div>

          <div className="scene-strip">
            <span className="label scene-strip-label">Scenes</span>
            <div className="scene-strip-row">
              {scenes.map((scene: Scene) => (
                <button key={scene.id} className="scene-chip" onClick={() => seekTo(scene.startS)}>
                  {scene.keyframePath && <img src={mediaUrl(scene.keyframePath)} alt="" />}
                  <span className="scene-chip-tc mono">{scene.startTc}</span>
                </button>
              ))}
              {scenes.length === 0 && (
                <span className="scene-strip-empty mono">
                  {audioOnly ? "Audio-only clip, no visual scenes." : "No scenes indexed yet."}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="clip-transcript-col">
          <span className="label transcript-label">Transcript</span>
          <div className="transcript-list">
            {segments.length === 0 && <p className="transcript-empty mono">No transcript available.</p>}
            {segments.map((seg: TranscriptSegment) => (
              <button
                key={seg.id}
                className={`transcript-seg${activeSegmentId === seg.id ? " active" : ""}`}
                onClick={() => seekTo(seg.startS)}
              >
                <div className="transcript-seg-head">
                  <TimecodeText tc={formatDuration(seg.startS)} dim />
                  {seg.speaker && <span className="transcript-speaker label">{seg.speaker}</span>}
                </div>
                <p className="transcript-text">{seg.text}</p>
              </button>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .clip-screen {
          height: 100%;
          display: flex;
          flex-direction: column;
        }
        .clip-loading {
          margin: 48px;
          color: var(--ink-dimmer);
          font-size: 12px;
        }
        .clip-loading-error {
          margin: 48px;
        }
        .clip-header {
          padding: 32px 48px 20px;
          border-bottom: 1px solid var(--hairline);
          flex: 0 0 auto;
        }
        .clip-back {
          background: transparent;
          border: none;
          color: var(--ink-dimmer);
          padding: 0;
          margin-bottom: 14px;
          font-size: 11px;
          transition: color var(--dur-fast) var(--ease-out);
        }
        .clip-back:hover {
          color: var(--accent);
        }
        .clip-title {
          font-size: 24px;
          color: var(--ink);
          margin: 0 0 8px;
        }
        .clip-meta-line {
          font-size: 11.5px;
          color: var(--ink-dimmer);
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0;
        }
        .clip-audio-chip {
          color: var(--accent);
          border: 1px solid var(--accent-dim);
          border-radius: 4px;
          padding: 2px 6px;
          line-height: 1.2;
        }
        .clip-meta-separator {
          margin: 0 7px;
        }
        .clip-body {
          flex: 1;
          display: grid;
          grid-template-columns: 1.6fr 1fr;
          overflow: hidden;
        }
        .clip-player-col {
          padding: 32px 32px 32px 48px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 28px;
        }
        .clip-player-wrap {
          width: 100%;
          background: #000;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: var(--shadow-card);
        }
        .clip-player-wrap.audio {
          background: var(--ground-raised);
          border: 1px solid var(--hairline);
        }
        .clip-player-wrap.unavailable {
          background: var(--ground-raised);
          border: 1px solid var(--hairline);
        }
        .clip-preview-unavailable {
          min-height: 230px;
          padding: 42px;
          display: grid;
          place-items: center;
          text-align: center;
          color: var(--ink-dimmer);
          font-size: 12px;
          line-height: 1.6;
        }
        .clip-video {
          width: 100%;
          display: block;
          aspect-ratio: 16 / 9;
          background: #000;
        }
        .clip-audio-player {
          min-height: 230px;
          padding: 38px 42px 30px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background: radial-gradient(circle at 50% 38%, var(--accent-wash), transparent 40%);
        }
        .clip-audio-mark {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          color: var(--ink-dimmer);
        }
        .clip-audio-mark .label {
          color: var(--ink-faint);
        }
        .clip-audio {
          width: 100%;
          height: 36px;
          color-scheme: dark;
          accent-color: var(--accent);
        }
        .scene-strip-label {
          display: block;
          margin-bottom: 12px;
        }
        .scene-strip-row {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          padding-bottom: 6px;
        }
        .scene-chip {
          flex: 0 0 auto;
          width: 120px;
          background: var(--ground-card);
          border: 1px solid var(--hairline);
          border-radius: 6px;
          overflow: hidden;
          padding: 0;
          position: relative;
        }
        .scene-chip img {
          width: 100%;
          aspect-ratio: 16 / 9;
          object-fit: cover;
          display: block;
          filter: saturate(0.85) brightness(0.9);
          transition: filter var(--dur-fast) var(--ease-out);
        }
        .scene-chip:hover img {
          filter: saturate(1) brightness(1);
        }
        .scene-chip-tc {
          display: block;
          font-size: 9.5px;
          color: var(--ink-dimmer);
          padding: 4px 6px;
          text-align: left;
        }
        .scene-strip-empty {
          font-size: 11px;
          color: var(--ink-faint);
        }
        .clip-transcript-col {
          border-left: 1px solid var(--hairline);
          padding: 32px 48px 32px 32px;
          overflow-y: auto;
        }
        .transcript-label {
          display: block;
          margin-bottom: 18px;
        }
        .transcript-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .transcript-empty {
          font-size: 11px;
          color: var(--ink-faint);
        }
        .transcript-seg {
          text-align: left;
          background: transparent;
          border: none;
          border-left: 2px solid transparent;
          padding: 9px 0 9px 14px;
          border-radius: 4px;
          transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
        }
        .transcript-seg:hover {
          background: rgba(255, 255, 255, 0.02);
        }
        .transcript-seg.active {
          background: var(--accent-wash);
          border-left-color: var(--accent);
        }
        .transcript-seg-head {
          display: flex;
          align-items: baseline;
          gap: 10px;
          margin-bottom: 4px;
        }
        .transcript-speaker {
          color: var(--ink-dimmer);
        }
        .transcript-text {
          font-size: 13.5px;
          line-height: 1.6;
          color: var(--ink-dim);
          margin: 0;
        }
        .transcript-seg.active .transcript-text {
          color: var(--ink);
        }
      `}</style>
    </div>
  );
}
