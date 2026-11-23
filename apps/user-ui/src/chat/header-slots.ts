// Where a chat's header controls go when a host lays out its own header (the canvas chat sheet, the mock's `.ch-head`).
// Without a provider the thread keeps its own row above the messages.
import {createContext} from 'react';

export type ChatHeaderSlots = {
  /** Icon-sized actions on the title row (Huddle). */
  actions: HTMLElement | null;
  /** The host's More menu (Sharing, Export chat). */
  more: HTMLElement | null;
};
export const ChatHeaderSlotsContext = createContext<ChatHeaderSlots | null>(null);
