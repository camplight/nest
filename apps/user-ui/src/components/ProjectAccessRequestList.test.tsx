import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectAccessNotification } from '@nest/schemas';
import { ProjectAccessRequestList } from './ProjectAccessRequestList';

const pending: ProjectAccessNotification = {
  id: 'request-1',
  projectId: 'project-1',
  projectName: 'Secret launch',
  projectCollaboration: 'private',
  requesterId: 'human-1',
  requesterUsername: 'Naska',
  requesterAvailable: true,
  status: 'pending',
  createdAt: 123,
};

function render(items: ProjectAccessNotification[], busyId: string | null = null) {
  return renderToStaticMarkup(
    <ProjectAccessRequestList
      items={items}
      busyId={busyId}
      onApprove={() => undefined}
      onDeny={() => undefined}
    />,
  );
}

it('renders accessible approve and deny controls with the private-project consequence', () => {
  const html = render([pending]);
  expect(html).toContain('Naska requested access to Secret launch');
  expect(html).toContain('aria-label="Approve Naska for Secret launch"');
  expect(html).toContain('aria-label="Deny Naska for Secret launch"');
  expect(html).toContain('Approving makes this a team project');
  expect(html).toContain('project chat and files');
});

it('omits the team conversion warning for an existing team project', () => {
  const html = render([{...pending, projectCollaboration: 'team'}]);
  expect(html).not.toContain('Approving makes this a team project');
});

it('renders approving as incomplete and retryable without a deny action', () => {
  const html = render([{...pending, status: 'approving'}]);
  expect(html).toContain('Approval needs completion');
  expect(html).toContain('aria-label="Retry approval for Naska in Secret launch"');
  expect(html).not.toContain('aria-label="Deny Naska for Secret launch"');
});

it('disables both controls and exposes progress for the busy row', () => {
  const html = render([pending], pending.id);
  expect(html.match(/disabled/g)?.length).toBe(2);
  expect(html).toContain('Updating project access…');
});
