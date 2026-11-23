import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ShareAvatars,avatarPeople} from './ShareAvatars';

const member=(humanId:string,username:string)=>({humanId,username,role:'edit' as const});
describe('avatarPeople',()=>{
  it('leaves the viewer out and keeps at most three, counting the rest',()=>{
    const people=avatarPeople([member('me','me'),member('a','ana'),member('b','bo'),member('c','cy'),member('d','di'),member('e','ed')],'me');
    expect(people.shown.map(p=>p.humanId)).toEqual(['a','b','c']);
    expect(people.more).toBe(2);
  });
});
describe('ShareAvatars',()=>{
  it('renders initials then +N, with the tooltip',()=>{
    const html=renderToStaticMarkup(<ShareAvatars viewerId="me" members={[member('a','ana'),member('b','bo'),member('c','cy'),member('d','di')]}/>);
    expect(html).toContain('title="People with access"');
    expect(html).toContain('>A<'); expect(html).toContain('>B<'); expect(html).toContain('>C<');
    expect(html).not.toContain('>D<');
    expect(html).toContain('+1');
  });
  it('renders nothing with no other members',()=>{
    expect(renderToStaticMarkup(<ShareAvatars viewerId="me" members={[member('me','me')]}/>)).toBe('');
    expect(renderToStaticMarkup(<ShareAvatars viewerId="me" members={[]}/>)).toBe('');
  });
});
