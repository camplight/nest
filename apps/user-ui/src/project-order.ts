import type {Project} from '@nest/schemas';
export function projectOrder(a:Project,b:Project) {
  return Number(!!b.starred)-Number(!!a.starred)||(b.lastActivityAt??b.createdAt)-(a.lastActivityAt??a.createdAt)||a.id.localeCompare(b.id);
}
