// Hover cards (the working ring on a working row or a reply's avatar) never open on touch: Radix HoverCard ignores
// touch pointers. A tap toggles them instead; a tap elsewhere closes them through the card's own outside-press dismissal.
import {useRef,useState,type MouseEvent,type PointerEvent} from 'react';

/** What a click does to the card: a touch tap opens it, or closes it when it was open as the tap began; others leave it. */
export function tapToggle(pointerType:string|null,wasOpen:boolean):boolean|null{
 return pointerType==='touch'?!wasOpen:null;
}

/** Controlled open state for a HoverCard.Root plus the trigger handlers that open it on a tap. */
export function useTapCard(){
 const [open,setOpen]=useState(false);
 const press=useRef<{pointerType:string;wasOpen:boolean}|null>(null);
 const openRef=useRef(open);openRef.current=open;
 return {
  open,
  onOpenChange:setOpen,
  triggerProps:{
   // Read before the card's outside-press dismissal (a document listener) closes it, so a second tap closes it.
   onPointerDown:(event:PointerEvent<HTMLElement>)=>{press.current={pointerType:event.pointerType,wasOpen:openRef.current};},
   onClick:(_event:MouseEvent<HTMLElement>)=>{
    const next=tapToggle(press.current?.pointerType??null,press.current?.wasOpen??false);
    press.current=null;
    if(next!==null)setOpen(next);
   },
  },
 };
}
