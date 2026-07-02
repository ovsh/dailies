import { useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api";
import type { FileDetail, Scene, TranscriptSegment } from "../../shared/types";
import { TimecodeText } from "../components/TimecodeText";

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
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    api.getFileDetail(fileId).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  useEffect(() => {
    if (detail && videoRef.current) {
      videoRef.current.currentTime = seekS;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, fileId, seekS]);

  function handleTimeUpdate() {
    if (!videoRef.current || !detail) return;
    const t = videoRef.current.currentTime;
    const seg = detail.segments.find((s) => t >= s.startS && t < s.endS);
    setActiveSegmentId(seg?.id ?? null);
  }

  function seekTo(s: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = s;
      videoRef.current.play().catch(() => {});
    }
  }

  if (!detail) {
    return (
      <div className="clip-screen">
        <p className="clip-loading mono">Loading…</p>
      </div>
    );
  }

  const { file, scenes, segments } = detail;
  const videoSrc = api.fileUrl(file.proxyPath ?? file.path);

  return (
    <div className="clip-screen">
      <header className="clip-header">
        <button className="clip-back label" onClick={onBack}>
          ← Back
        </button>
        <h1 className="display clip-title">{file.filename}</h1>
        <p className="clip-meta-line mono">
          {file.fps.toFixed(3)} FPS · <TimecodeText tc={file.startTc} dim /> · {formatDuration(file.durationS)} · {file.codec} ·{" "}
          {file.role === "raw" ? "RAW" : "FINAL"}
        </p>
      </header>

      <div className="clip-body">
        <div className="clip-player-col">
          <div className="clip-player-wrap">
            <video
              ref={videoRef}
              className="clip-video"
              src={videoSrc}
              controls
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={() => {
                if (videoRef.current) videoRef.current.currentTime = seekS;
              }}
            />
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
              {scenes.length === 0 && <span className="scene-strip-empty mono">No scenes indexed yet.</span>}
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
        .clip-video {
          width: 100%;
          display: block;
          aspect-ratio: 16 / 9;
          background: #000;
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
