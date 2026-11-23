import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoicePlayer} from './VoicePlayer';
import {VOICE_BARS} from './voice-player';

describe('VoicePlayer',()=>{
 const html=renderToStaticMarkup(<VoicePlayer src="blob:x" name="Voice note.webm"/>);
 it('draws a Nest player instead of the browser controls',()=>{
  expect(html).toContain('<audio');
  expect(html).not.toMatch(/<audio[^>]*controls/);
  expect(html).toContain('aria-label="Play Voice note.webm"');
  expect(html).toContain('aria-label="Playback speed 1×"');
  expect(html).toContain('>0:00<');
 });
 it('has a keyboard seek slider with a readable value and one bar per peak',()=>{
  expect(html).toContain('role="slider"');
  expect(html).toContain('aria-label="Position in Voice note.webm"');
  expect(html).toContain('aria-valuetext="0:00 of 0:00"');
  expect(html.match(/<i /g)?.length).toBe(VOICE_BARS);
 });
 it('is compact in chat messages',()=>{
  expect(renderToStaticMarkup(<VoicePlayer src="blob:x" name="v.webm" size="compact"/>)).toContain('data-size="compact"');
 });
});
