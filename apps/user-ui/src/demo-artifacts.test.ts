import {describe,it,expect} from 'vitest';
import {demoArtifacts} from './demo-artifacts';
describe('demo artifact links',()=>{
 it('recognizes deployed links and deduplicates canonical paths',()=>{
 expect(demoArtifacts('[Open](https://nest.example/demo/launch) /demo/launch/','https://nest.example')).toEqual(['/demo/launch']);
 });
 it('excludes other origins, credentials, nested files and invalid slugs',()=>{
 expect(demoArtifacts('https://evil.example/demo/launch https://user@nest.example/demo/launch https://nest.example/demo/launch/file https://nest.example/demo/-bad','https://nest.example')).toEqual([]);
 });
});
