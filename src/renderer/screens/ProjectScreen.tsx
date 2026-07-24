import { useEffect, useState } from "react";
import { api } from "../api";
import type { Project, ProjectState } from "../../shared/types";

interface ProjectScreenProps {
  /** Called once a project has been opened, with its full state. */
  onProjectOpened: (state: ProjectState) => void;
}

function formatLastOpened(iso: string | null): string {
  if (!iso) return "never opened";
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const year = d.getFullYear();
  return `last opened ${day} ${month} ${year}`;
}

/**
 * The entry surface — shown when no project is open, or when the user clicks
 * back to the project mark in the rail. Full-bleed on the desktop ground.
 */
export function ProjectScreen({ onProjectOpened }: ProjectScreenProps) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listProjects().then(setProjects);
  }, []);

  async function open(id: string) {
    setOpening(id);
    setError(null);
    try {
      const state = await api.openProject(id);
      onProjectOpened(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the project.");
    } finally {
      setOpening(null);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const project = await api.createProject(name);
      setNewName("");
      const state = await api.openProject(project.id);
      onProjectOpened(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the project.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="project-screen">
      <div className="project-panel">
        <div className="project-bar">
          <span className="project-bar-close" aria-hidden="true" />
          <span className="project-bar-title">Projects</span>
          <span className="project-bar-stripes" aria-hidden="true" />
        </div>
        <div className="project-body">
          <div className="project-list">
            {projects === null && <p className="project-loading mono">Loading…</p>}
            {projects?.map((p) => (
              <button
                key={p.id}
                className="project-line"
                onClick={() => open(p.id)}
                disabled={opening !== null}
              >
                <span className="mono project-line-name">{p.name}</span>
                <span className="project-line-sub mono">
                  {opening === p.id ? "opening…" : formatLastOpened(p.lastOpenedAt)}
                </span>
              </button>
            ))}
          </div>

          {error && <p className="project-error mono">{error}</p>}

          <div className="project-new">
            <input
              className="project-new-input mono"
              placeholder="New project…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              disabled={creating}
            />
            <button className="project-create" onClick={create} disabled={!newName.trim() || creating}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .project-screen {
          position: absolute;
          inset: 0;
          background: var(--ground);
          background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.045) 0 1px, transparent 1px 7px);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          overflow-y: auto;
          padding: 64px 24px;
          animation: fade-in var(--dur-med) var(--ease-out) both;
        }
        .project-panel {
          width: 560px;
          max-width: 100%;
          height: fit-content;
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out), 4px 6px 0 rgba(23, 25, 27, 0.28);
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .project-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 7px 10px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
          user-select: none;
        }
        .project-bar-close {
          width: 13px;
          height: 13px;
          flex: none;
          background: var(--ground-raised);
          box-shadow: var(--bevel-out);
          border: 1px solid var(--chrome-lo);
        }
        .project-bar-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--ink);
        }
        .project-bar-stripes {
          flex: 1;
          height: 9px;
          background: repeating-linear-gradient(0deg, var(--chrome-lo) 0 1px, transparent 1px 3px);
          opacity: 0.5;
        }
        .project-body {
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          margin: 10px;
          padding: 6px 26px 26px;
        }
        .project-loading {
          font-size: 12px;
          color: var(--ink-dimmer);
          padding: 18px 4px;
        }
        .project-list {
          display: flex;
          flex-direction: column;
        }
        .project-line {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 20px;
          background: transparent;
          border: none;
          border-bottom: 1px solid var(--paper-alt);
          padding: 18px 6px;
          text-align: left;
        }
        .project-line:nth-child(even) {
          background: var(--paper-alt);
        }
        .project-line:hover:not(:disabled) {
          background: #d2d6d9;
        }
        .project-line:disabled {
          cursor: default;
        }
        .project-line-name {
          font-size: 18px;
          font-weight: 500;
          color: var(--ink);
        }
        .project-line-sub {
          flex: 0 0 auto;
          font-size: 10.5px;
          color: var(--ink-faint);
        }
        .project-error {
          color: var(--status-error);
          font-size: 12px;
          margin: 14px 0 0;
        }
        .project-new {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-top: 24px;
          padding-top: 22px;
          border-top: 1px solid var(--hairline);
        }
        .project-new-input {
          flex: 1;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          color: var(--ink);
          font-size: 12.5px;
          padding: 9px 11px;
        }
        .project-new-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .project-new-input::placeholder {
          color: var(--ink-faint);
        }
        .project-create {
          flex: 0 0 auto;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 999px;
          font-family: var(--font-body);
          font-size: 11.5px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #fff;
          padding: 11px 20px;
          box-shadow: inset 1px 2px 0 rgba(255,255,255,.28), inset -1px -2px 0 rgba(0,0,0,.22), 2px 3px 0 rgba(23,25,27,.3);
        }
        .project-create:hover:not(:disabled) {
          transform: translate(1px, 1px);
          box-shadow: inset 1px 2px 0 rgba(255,255,255,.28), inset -1px -2px 0 rgba(0,0,0,.22), 1px 1px 0 rgba(23,25,27,.3);
        }
        .project-create:disabled {
          background: var(--ink-faint);
          border-color: var(--ink-faint);
          cursor: default;
          box-shadow: none;
        }
      `}</style>
    </div>
  );
}
