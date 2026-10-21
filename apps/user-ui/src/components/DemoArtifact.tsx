import {useState} from 'react';
import './demo-artifact.css';

export function DemoArtifact({path, onClose, onEdit, editable}: {path:string; onClose:()=>void; onEdit:()=>void; editable:boolean}) {
  const [revision,setRevision]=useState(0);
  const [mobile,setMobile]=useState(false);
  return <aside className="demo-artifact" aria-label="Demo artifact preview">
    <header><div><small>Demo artifact</small><h2>{path.slice(6).replaceAll('-',' ')}</h2></div><button type="button" onClick={onClose} aria-label="Close artifact preview">×</button></header>
    <div className="demo-artifact-actions">
      <button type="button" onClick={onEdit} disabled={!editable}>Request changes</button>
      <button type="button" onClick={()=>setRevision(r=>r+1)}>Refresh preview</button>
      <button type="button" aria-pressed={mobile} onClick={()=>setMobile(v=>!v)}>Phone width</button>
      <a href={path} target="_blank" rel="noreferrer">Open demo ↗</a>
    </div>
    <p>Describe your edits in chat and select the agent. Refresh after it republishes the demo.</p>
    <div className={`demo-artifact-canvas${mobile?' phone':''}`}>
      <iframe key={path+revision} title="Demo preview" src={`${path}?preview=${revision}`} sandbox="allow-scripts" referrerPolicy="no-referrer" />
    </div>
    <small>Preview interactions are isolated. If the demo does not load, open it in a new tab to check access.</small>
  </aside>;
}
