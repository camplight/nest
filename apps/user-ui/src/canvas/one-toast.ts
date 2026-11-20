/** What the canvas toast shows: the canvas store's notice text and the id of the latest member notice. */
export type ToastShown={notice:string|null;member:number|null};

/**
 * The canvas shows one toast at a time (the mock's bottom-centre `.toast`). When a new one arrives while the other kind
 * is still up, the older one goes: returns which to clear, or null. Both arriving together keep the member notice,
 * which can carry an Undo.
 */
export function olderToast(prev:ToastShown,next:ToastShown):'notice'|'member'|null{
  if(!next.notice||next.member===null)return null;
  const noticeNew=next.notice!==prev.notice;
  const memberNew=next.member!==prev.member;
  if(memberNew)return 'notice';
  return noticeNew?'member':null;
}
