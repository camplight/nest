// Nest-written: an image opened large in a Radix dialog named by its alt text, with a link to the original (spec 7.1.4).
import { Dialog, DialogContent, DialogTitle } from "./dialog";

export function ImageZoom({ src, alt, open, onOpenChange }: {
  src: string; alt: string; open: boolean; onOpenChange(open: boolean): void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-h-[calc(100dvh-2rem)] sm:max-w-[min(64rem,calc(100%-2rem))]">
        <DialogTitle className="pe-8 break-words">{alt}</DialogTitle>
        <img src={src} alt={alt} className="mx-auto max-h-[70dvh] w-auto rounded-lg object-contain" />
        <a href={src} target="_blank" rel="noreferrer" className="justify-self-start text-(--nest-accent) underline underline-offset-2">
          Open original
        </a>
      </DialogContent>
    </Dialog>
  );
}
