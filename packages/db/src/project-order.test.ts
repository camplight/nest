import {it,expect} from 'vitest';
import {openProductDb} from './index';

it('orders personal stars before activity, isolates people, ignores failed sends and preserves activity on unstar',()=>{
  const store=openProductDb(':memory:');
  try {
    const db=store.projects;
    for(const [id,createdAt] of [['old',10],['new',20],['tie',20]] as const)
      db.createProject({id,name:id,description:'',createdAt,ownerId:'owner',channelId:id,collaboration:'team'});
    expect(db.projects('owner').map(p=>p.id)).toEqual(['new','tie','old']);
    db.recordActivity('old','owner',30);
    db.recordActivity('old','owner',25); // Delayed requests cannot move activity backwards.
    db.setStarred('new','owner',true);
    expect(db.projects('owner').map(p=>p.id)).toEqual(['new','old','tie']);
    expect(db.projects('teammate',['old','new','tie']).map(p=>p.id)).toEqual(['new','tie','old']);
    expect(db.projects('teammate',['old','new','tie']).every(p=>!p.starred)).toBe(true);
    const receipt=store.db.prepare('INSERT INTO product_message_requests VALUES (?,?,?,?,?,?,?,?,?)');
    receipt.run('sent','owner','owner','tie','hash','hash','event1',39,40);
    receipt.run('failed','owner','owner','old','hash','hash','event2',100,null);
    receipt.run('other','teammate','teammate','old','hash','hash','event3',199,200);
    expect(db.projects('owner').map(p=>p.id)).toEqual(['new','tie','old']);
    db.setStarred('new','owner',false);
    expect(db.projects('owner').map(p=>p.id)).toEqual(['tie','old','new']);
    expect(db.personalize(db.project('old')!,'owner').lastActivityAt).toBe(30);
    expect(db.projects('stranger')).toEqual([]);
  } finally {store.close();}
});
