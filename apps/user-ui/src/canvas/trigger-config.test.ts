import {describe,expect,it} from 'vitest';
import {appEventName,configFields,configInitial,configValue} from './trigger-config';

const schema={
  type:'object',required:['repo','limit'],
  properties:{
    branch:{type:'string',title:'Branch',description:'Which branch',default:'main'},
    repo:{type:'string'},
    limit:{type:'integer'},
    ratio:{type:'number'},
    draft:{type:'boolean',default:true},
    quiet:{type:'boolean'},
    state:{type:'string',enum:['open','closed']},
    filter:{type:'object',properties:{a:{type:'string'}}},
  },
};

describe('configFields',()=>{
  it('reads types, required (first), defaults, enums and the nested fallback',()=>{
    const fields=configFields(schema);
    expect(fields.map(f=>f.key)).toEqual(['repo','limit','branch','ratio','draft','quiet','state','filter']);
    const by=Object.fromEntries(fields.map(f=>[f.key,f]));
    expect([by.repo.required,by.repo.label,by.repo.type]).toEqual([true,'Repo','string']);
    expect([by.limit.type,by.ratio.type,by.draft.type,by.filter.type]).toEqual(['integer','number','boolean','json']);
    expect([by.branch.label,by.branch.description,by.branch.initial,by.branch.required]).toEqual(['Branch','Which branch','main',false]);
    expect([by.state.type,by.state.options]).toEqual(['enum',['open','closed']]);
    expect([by.draft.initial,by.quiet.initial]).toEqual([true,false]);
  });
  it('gives no fields for a schema without properties',()=>{
    expect(configFields(null)).toEqual([]);
    expect(configFields({type:'object'})).toEqual([]);
  });
});

describe('configValue',()=>{
  const fields=configFields(schema);
  it('builds the typed config, leaving optional empty fields out',()=>{
    const {config,problems}=configValue(fields,{...configInitial(fields),repo:' a/b ',limit:'5',ratio:'0.5',state:'open',filter:'{"a":"x"}'});
    expect(problems).toEqual([]);
    expect(config).toEqual({repo:'a/b',limit:5,ratio:0.5,branch:'main',draft:true,state:'open',filter:{a:'x'}});
  });
  it('sends false for an unchecked box whose default is true, and leaves an unchecked plain box out',()=>{
    const {config}=configValue(fields,{...configInitial(fields),repo:'a',limit:'1',draft:false});
    expect(config.draft).toBe(false);
    expect('quiet' in config).toBe(false);
  });
  it('reports a missing required field, a bad number and bad JSON',()=>{
    const {problems}=configValue(fields,{...configInitial(fields),limit:'1.5',ratio:'x',filter:'{'});
    expect(problems).toEqual(['Repo is required','Limit must be a whole number','Ratio must be a number','Filter must be valid JSON']);
  });
});

describe('appEventName',()=>{
  it('drops the app prefix',()=>{
    expect(appEventName('github','GITHUB_COMMIT_EVENT')).toBe('Commit event');
    expect(appEventName('github','OTHER_THING')).toBe('Other thing');
  });
});
