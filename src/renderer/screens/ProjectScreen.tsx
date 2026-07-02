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
 * back to the project mark in the rail. Full-bleed on the dark ground.
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
      <div className="project-screen-column">
        <span className="label project-screen-label">Projects</span>

        <div className="project-list">
          {projects === null && <p className="project-loading mono">Loading…</p>}
          {projects?.map((p) => (
            <button
              key={p.id}
              className="project-line"
              onClick={() => open(p.id)}
              disabled={opening !== null}
            >
              <span className="display project-line-name">{p.name}</span>
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
          <button className="ghost-btn label" onClick={create} disabled={!newName.trim() || creating}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      <style>{`
        .project-screen {
          position: absolute;
          inset: 0;
          background: var(--ground);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow-y: auto;
          animation: fade-in var(--dur-med) var(--ease-out) both;
        }
        .project-screen-column {
          width: 520px;
          max-width: calc(100vw - 96px);
          padding: 64px 0;
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .project-screen-label {
          display: block;
          margin-bottom: 28px;
        }
        .project-loading {
          font-size: 12px;
          color: var(--ink-dimmer);
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
          border-bottom: 1px solid var(--hairline);
          padding: 22px 0;
          text-align: left;
          transition: color var(--dur-fast) var(--ease-out);
        }
        .project-line:disabled {
          cursor: default;
        }
        .project-line-name {
          font-size: 30px;
          color: var(--ink);
          transition: color var(--dur-fast) var(--ease-out);
        }
        .project-line:hover .project-line-name {
          color: var(--accent);
        }
        .project-line-sub {
          flex: 0 0 auto;
          font-size: 10.5px;
          color: var(--ink-faint);
        }
        .project-error {
          color: var(--status-error);
          font-size: 12px;
          margin: 0 0 14px;
        }
        .project-new {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-top: 36px;
          padding-top: 28px;
          border-top: 1px solid var(--hairline);
        }
        .project-new-input {
          flex: 1;
          background: transparent;
          border: none;
          border-bottom: 1px solid var(--hairline-strong);
          color: var(--ink);
          font-size: 13px;
          padding: 8px 0;
          transition: border-color var(--dur-fast) var(--ease-out);
        }
        .project-new-input:focus {
          outline: none;
          border-color: var(--accent-dim);
        }
        .project-new-input::placeholder {
          color: var(--ink-faint);
        }
      `}</style>
    </div>
  );
}
