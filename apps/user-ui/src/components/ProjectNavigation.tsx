import {useEffect, useId, useState} from 'react';
import type {Project} from '@nest/schemas';
import {DesignIcon} from '../Dashboard';
import './project-navigation.css';

type Props = {
  projects: Project[];
  currentProjectId: string | null;
  inProjects: boolean;
  creating: boolean;
  unreadCounts: Record<string, number>;
  onBrowse: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
};
const shortcutLimit = 5;

export function ProjectNavigation({projects, currentProjectId, inProjects, creating, unreadCounts, onBrowse, onSelect, onCreate}: Props) {
  const [expanded, setExpanded] = useState(true);
  const childrenId = useId();
  useEffect(() => {
    if (currentProjectId || creating) setExpanded(true);
  }, [currentProjectId, creating]);
  const ordered = [...projects].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const shortcuts = ordered.slice(0, shortcutLimit);
  const current = ordered.find(project => project.id === currentProjectId);
  // Keep the open project in context without allowing the shortcut list to grow.
  if (current && !shortcuts.some(project => project.id === current.id)) shortcuts.splice(shortcutLimit - 1, 1, current);
  function browse() { setExpanded(true); onBrowse(); }
  return <div className="project-navigation">
    <div className={`project-navigation-parent${inProjects ? ' is-active' : ''}`}>
      <button type="button" data-tour="projects" className="project-navigation-browse" aria-current={inProjects && !currentProjectId && !creating ? 'page' : undefined} onClick={browse}>
        <DesignIcon name="conversations"/><span>Projects</span><span className="project-navigation-count" aria-hidden="true">{projects.length}</span>
      </button>
      <button type="button" className="project-navigation-toggle" aria-label={expanded ? 'Collapse projects' : 'Expand projects'} aria-expanded={expanded} aria-controls={childrenId} onClick={() => setExpanded(value => !value)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{transform:expanded ? 'rotate(90deg)' : undefined}}><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
    <ul id={childrenId} className="project-navigation-children" aria-label="Project shortcuts" hidden={!expanded}>
      {shortcuts.map(project => <li key={project.id}><button type="button" className="project-navigation-link" aria-current={currentProjectId === project.id ? 'page' : undefined} onClick={() => onSelect(project.id)} title={project.name}>
        <span className="project-navigation-marker" aria-hidden="true">#</span><span className="project-navigation-name">{project.name}</span>
        {unreadCounts[project.channelId] > 0 && <span className="project-navigation-unread" aria-label={`${unreadCounts[project.channelId]} unread messages`}>{unreadCounts[project.channelId]}</span>}
      </button></li>)}
      {projects.length > shortcutLimit && <li><button type="button" className="project-navigation-all" onClick={browse}>View all projects<span aria-hidden="true">→</span></button></li>}
      <li><button type="button" className="project-navigation-create" aria-current={creating ? 'page' : undefined} onClick={onCreate}><span aria-hidden="true">+</span>New project</button></li>
    </ul>
  </div>;
}
