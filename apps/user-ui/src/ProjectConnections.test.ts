import {expect,it} from 'vitest';
import {suggestedApps} from './ProjectConnections';
it('recognizes explicit app names, bounds suggestion density and avoids substring matches',()=>{
  expect(suggestedApps('Organize Trello cards and Slack updates')).toEqual(['trello','slack']);
  expect(suggestedApps('Use Google Drive and Google Calendar')).toEqual(['googledrive','googlecalendar']);
  expect(suggestedApps('Research a trellogram and slackness')).toEqual([]);
  expect(suggestedApps('Trello Slack GitHub Miro WordPress')).toHaveLength(2);
});
