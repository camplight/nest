import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Project} from '@nest/schemas';
import {inviteNote,keepsProjectPage,splitArchived} from './project-archive';
import {ProjectGrid} from './Projects';
import {ProjectNavigation} from './components/ProjectNavigation';

const project=(id:string,createdAt:number,archived?:boolean):Project=>({id,ownerId:'u',channelId:`c-${id}`,name:`Project ${id}`,description:'',createdAt,...(archived?{archived}:{})});
const noop=()=>{};

describe('splitArchived',()=>{
  it('splits on archived and keeps order',()=>{
    const list=[project('a',1),project('b',2,true),project('c',3),project('d',4,true)];
    expect(splitArchived(list)).toEqual({active:[list[0],list[2]],archived:[list[1],list[3]]});
  });
});

describe('ProjectGrid',()=>{
  it('lists archived projects only in a collapsed Archived section, each tagged',()=>{
    const html=renderToStaticMarkup(<ProjectGrid projects={[project('a',1),project('b',2,true),project('c',3,true)]} onSelect={noop}/>);
    const [before,section]=html.split('<details');
    expect(before).toContain('Project a');expect(before).not.toContain('Project b');
    expect(section).toMatch(/^ class="project-archived"><summary>Archived \(2\)<\/summary>/);
    expect(section.match(/chat-archived-tag">Archived</g)).toHaveLength(2);
    expect(section).toContain('Project b');expect(section).toContain('Project c');
  });
  it('has no Archived section when nothing is archived',()=>{
    expect(renderToStaticMarkup(<ProjectGrid projects={[project('a',1)]} onSelect={noop}/>)).not.toContain('<details');
  });
});

describe('ProjectNavigation',()=>{
  it('leaves archived projects out of the sidebar list and its count',()=>{
    const html=renderToStaticMarkup(<ProjectNavigation projects={[project('a',1),project('b',2,true)]} currentProjectId={null} inProjects={false} creating={false} unreadCounts={{}} onBrowse={noop} onSelect={noop} onCreate={noop}/>);
    expect(html).toContain('Project a');expect(html).not.toContain('Project b');
    expect(html).toContain('project-navigation-count" aria-hidden="true">1<');
    expect(html).toContain('View all projects');
  });
  it('keeps the open project in the list even when it is archived',()=>{
    const html=renderToStaticMarkup(<ProjectNavigation projects={[project('a',1),project('b',2,true)]} currentProjectId="b" inProjects creating={false} unreadCounts={{}} onBrowse={noop} onSelect={noop} onCreate={noop}/>);
    expect(html).toContain('Project b');
  });
});

describe('keepsProjectPage',()=>{
  const projects=[project('a',1)];
  it('keeps the project page when its chat is archived, as long as the project is listed',()=>{
    expect(keepsProjectPage({selectedProject:'a',channelId:'c-a',projects,channels:[{id:'c-a',archivedAt:5}]})).toBe(true);
    expect(keepsProjectPage({selectedProject:'a',channelId:'c-a',projects,channels:[{id:'c-a',archivedAt:null}]})).toBe(true);
  });
  it('lets go when the project or its chat is gone, or another chat is chosen',()=>{
    expect(keepsProjectPage({selectedProject:'a',channelId:'c-a',projects:[],channels:[{id:'c-a',archivedAt:5}]})).toBe(false);
    expect(keepsProjectPage({selectedProject:'a',channelId:'c-a',projects,channels:[]})).toBe(false);
    expect(keepsProjectPage({selectedProject:'a',channelId:'other',projects,channels:[{id:'other'}]})).toBe(false);
  });
});

describe('ProjectGrid empty state',()=>{
  it('shows the empty card when every project is archived, above the Archived section',()=>{
    const html=renderToStaticMarkup(<ProjectGrid projects={[project('b',2,true)]} onSelect={noop} empty={<p>Nothing active</p>}/>);
    expect(html.indexOf('Nothing active')).toBeGreaterThan(-1);
    expect(html.indexOf('Nothing active')).toBeLessThan(html.indexOf('<details'));
    expect(renderToStaticMarkup(<ProjectGrid projects={[project('a',1)]} onSelect={noop} empty={<p>Nothing active</p>}/>)).not.toContain('Nothing active');
  });
});

describe('inviteNote',()=>{
  it('tells the owner of an archived project how to change it, and others who manages invitations',()=>{
    expect(inviteNote({owner:true,archived:true})).toBe('This project is archived. Unarchive it to edit or invite.');
    expect(inviteNote({owner:false,archived:true})).toBe('The project owner manages invitations.');
    expect(inviteNote({owner:false,archived:false})).toBe('The project owner manages invitations.');
    expect(inviteNote({owner:true,archived:false})).toBeNull();
  });
});
