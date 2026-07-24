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
        <h1 className="clip-title mono">{file.filename}</h1>
        <p className="clip-meta-line mono">
          {audioOnly ? (
            <><span className="clip-chip">Audio</span><span className="clip-meta-separator">·</span></>
          ) : file.fps > 0 ? (
            <>{file.fps.toFixed(3)} FPS <span className="clip-meta-separator">·</span></>
          ) : null}
          <TimecodeText tc={file.startTc} dim /> · {formatDuration(file.durationS)} · {file.codec} ·{" "}
          <span className="clip-chip">{file.role === "raw" ? "RAW" : "FINAL"}</span>
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
          background: var(--ground-card);
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
          padding: 28px 48px 18px;
          border-bottom: 1px solid var(--panel-border);
          box-shadow: inset 0 -1px 0 var(--chrome-hi);
          flex: 0 0 auto;
          background: var(--ground-card);
        }
        .clip-back {
          display: inline-flex;
          align-items: center;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-out);
          border-radius: 2px;
          color: var(--ink-dim);
          padding: 5px 10px;
          margin-bottom: 16px;
          font-size: 10.5px;
        }
        .clip-back:hover {
          background: #d2d6d9;
          color: var(--ink);
        }
        .clip-back:active {
          box-shadow: var(--bevel-in);
        }
        .clip-title {
          font-size: 21px;
          font-weight: 600;
          color: var(--ink);
          margin: 0 0 9px;
        }
        .clip-meta-line {
          font-size: 11.5px;
          color: var(--ink-dimmer);
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0;
        }
        .clip-chip {
          display: inline-flex;
          align-items: center;
          font-family: var(--font-mono);
          font-size: 9.5px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-dim);
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-out);
          border-radius: 2px;
          padding: 2px 7px;
          line-height: 1.4;
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
          padding: 28px 32px 32px 48px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 26px;
        }
        .clip-player-wrap {
          width: 100%;
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          padding: 8px;
          box-shadow: var(--bevel-out), var(--shadow-card);
        }
        .clip-preview-unavailable {
          min-height: 230px;
          padding: 42px;
          display: grid;
          place-items: center;
          text-align: center;
          background: var(--bezel);
          color: var(--bezel-ink);
          border-radius: 1px;
          font-size: 12px;
          line-height: 1.6;
        }
        .clip-video {
          width: 100%;
          display: block;
          aspect-ratio: 16 / 9;
          background: var(--bezel);
          border-radius: 1px;
        }
        .clip-audio-player {
          min-height: 230px;
          padding: 38px 42px 30px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background: var(--bezel);
          border-radius: 1px;
        }
        .clip-audio-mark {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          color: var(--bezel-ink);
        }
        .clip-audio-mark .label {
          color: var(--bezel-ink);
          opacity: 0.7;
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
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          box-shadow: var(--bevel-out);
          border-radius: 2px;
          overflow: hidden;
          padding: 4px 4px 5px;
          position: relative;
        }
        .scene-chip img {
          width: 100%;
          aspect-ratio: 16 / 9;
          object-fit: cover;
          display: block;
          background: var(--bezel);
          border-radius: 1px;
          filter: saturate(0.85) brightness(0.92);
          transition: filter var(--dur-fast) var(--ease-out);
        }
        .scene-chip:hover img {
          filter: saturate(1) brightness(1);
        }
        .scene-chip-tc {
          display: block;
          font-size: 9.5px;
          color: var(--ink-dimmer);
          padding: 4px 2px 0;
          text-align: left;
        }
        .scene-strip-empty {
          font-size: 11px;
          color: var(--ink-faint);
        }
        .clip-transcript-col {
          border-left: 1px solid var(--panel-border);
          box-shadow: inset 1px 0 0 var(--chrome-hi);
          padding: 28px 48px 32px 32px;
          overflow-y: auto;
          background: var(--ground-card);
        }
        .transcript-label {
          display: block;
          margin-bottom: 18px;
        }
        .transcript-list {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .transcript-empty {
          font-size: 11px;
          color: var(--ink-faint);
        }
        .transcript-seg {
          text-align: left;
          background: transparent;
          border: none;
          padding: 9px 10px 9px 12px;
          border-radius: 2px;
        }
        .transcript-seg:nth-child(even) {
          background: var(--paper-alt);
        }
        .transcript-seg:hover {
          background: var(--accent-wash);
        }
        .transcript-seg.active {
          background: var(--select-bg);
          --ink: var(--select-ink);
          --ink-dim: var(--select-ink);
          --ink-dimmer: var(--select-ink);
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
          color: var(--select-ink);
        }
      `}</style>
    </div>
  );
}
