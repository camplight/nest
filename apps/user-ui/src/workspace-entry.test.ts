import {describe,it,expect} from 'vitest';
import {canonicalWorkspaceEntry,isOnboardingEntry} from './workspace-entry';
describe('workspace links from the legacy onboarding path',()=>{
 it.each(['chat','files'])('keeps a project %s destination and its message',tab=>{
  const input=new URL(`https://nest.example/onboarding?view=projects&project=project-id&tab=${tab}&message=message-id`);
  const result=canonicalWorkspaceEntry(input);
  expect(result.pathname).toBe('/');expect(result.search).toBe(input.search);
  expect(input.pathname).toBe('/onboarding');expect(isOnboardingEntry(input)).toBe(false);
 });
 it.each(['/onboarding','/?view=onboarding','/onboarding?connected_account_id=fixture'])('preserves setup entry %s',path=>{
  expect(isOnboardingEntry(new URL(path,'https://nest.example'))).toBe(true);
 });
 it.each(['agents','community','dashboard'])('preserves explicit %s navigation',view=>{
  const input=new URL(`https://nest.example/onboarding?view=${view}`);
  expect(canonicalWorkspaceEntry(input).pathname).toBe('/');expect(isOnboardingEntry(input)).toBe(false);
 });
});
